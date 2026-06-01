import * as chokidar from 'chokidar';
import { getLogger } from '../utils/logger.js';

/**
 * Debounced file watcher used by `cdkl start-api --watch`
 * (PR 8c, issue #235).
 *
 * Wraps {@link chokidar.watch} with a 500ms debounce window so a burst
 * of file writes (e.g. an editor save plus its sidecar files, or a
 * `tsc` emit) collapses to one `'reload'` event.
 *
 * `--watch` watches the CDK app's source tree (the directory holding
 * `cdk.json`), so editing handler / construct source re-synths and
 * hot-reloads. The synth output directory (`cdk.out/`) is excluded via
 * {@link FileWatcherOptions.ignored} so the reload's own re-synth writes
 * never re-trigger the watcher (no self-fire loop).
 *
 * Emits a single `'reload'` callback per debounce window. Does NOT
 * pass the changed file path — the orchestrator re-runs the full
 * synth -> discover -> diff sequence regardless of which file changed,
 * because `cdk synth` rewrites template + asset paths atomically and
 * the orchestrator can't reason about partial updates.
 */

export interface FileWatcher {
  /** Stop watching everything. */
  close(): Promise<void>;
}

export interface FileWatcherOptions {
  /** Initial set of paths to watch. */
  paths: readonly string[];
  /**
   * Callback fired (debounced) when any watched path changes. The set
   * of paths that triggered the firing in this debounce window is
   * passed in (de-duplicated, raw chokidar paths — typically absolute
   * when the watched root was absolute, otherwise relative to the
   * cwd). The callback may ignore the argument; the array is provided
   * for callers that need to classify what changed (Phase 4 of issue
   * #214 — the ECS service emulator's `--watch` reload pathway routes
   * source-only edits through a fast path that skips `docker build`).
   */
  onChange: (changedPaths: readonly string[]) => void;
  /** Debounce window in ms. Default 500ms (issue brief). */
  debounceMs?: number;
  /**
   * Pass `true` to suppress the initial `'add'` event chokidar
   * normally fires for every existing file when the watcher starts up
   * — without this, watching the app source tree would fire `'reload'`
   * immediately for every existing source file. Default `true`.
   */
  ignoreInitial?: boolean;
  /**
   * Predicate forwarded to chokidar's `ignored` option. Returning
   * `true` prunes the path (and, for a directory, its whole subtree)
   * from the watch. Used to exclude the synth output directory,
   * `node_modules`, `.git`, and `cdk.json` `watch.exclude` globs when
   * watching the app source tree. Decides on the path alone so it is
   * safe on chokidar's pre-stat probe call (which omits `stats`).
   */
  ignored?: (path: string) => boolean;
  /**
   * Per-path gate checked on each raw chokidar event BEFORE the
   * debounce timer is (re)armed. Returning `false` drops the event so
   * it does not trigger a reload — used to honor `cdk.json`
   * `watch.include` (only matching source files trigger a reload).
   * Unlike {@link FileWatcherOptions.ignored} this never affects
   * chokidar's directory traversal, so include filtering can't prune a
   * directory the watcher must descend into. Default: every event
   * fires.
   */
  shouldTrigger?: (path: string) => boolean;
}

const DEFAULT_DEBOUNCE_MS = 500;

/**
 * Construct a {@link FileWatcher}. The watcher is active immediately
 * (chokidar starts listening before this function returns); the
 * caller does not need to `await` ready.
 *
 * Errors from chokidar (typically "ENOENT: path doesn't exist", or
 * EMFILE on macOS when watching a deep tree) are logged at WARN and
 * otherwise swallowed — the start-api server should keep serving even
 * when one of the watched asset directories goes missing during a
 * reload, but the user gets a visible signal that `--watch` may have
 * stopped firing so they don't sit there waiting for a reload that
 * will never come.
 */
export function createFileWatcher(options: FileWatcherOptions): FileWatcher {
  const logger = getLogger().child('start-api-watch');
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const ignoreInitial = options.ignoreInitial !== false;

  const watcher = chokidar.watch([...options.paths], {
    ignoreInitial,
    // Don't follow symlinks — asset directories under `cdk.out/asset.<hash>/`
    // are real directories; following symlinks would risk cycling into
    // `node_modules` or similar.
    followSymlinks: false,
    // Don't crash on permission errors.
    ignorePermissionErrors: true,
    ...(options.ignored && { ignored: options.ignored }),
  });

  let timer: NodeJS.Timeout | null = null;
  // Per-debounce-window accumulator. Reset to a fresh Set at the start
  // of each new window (= when `fire()` arms the timer with the
  // accumulator empty). Each qualifying chokidar event adds its path.
  // The callback receives the de-duplicated path array on flush.
  let pending = new Set<string>();
  // `closed` is checked in BOTH `fire()` (so a chokidar event arriving
  // mid-`close()` doesn't schedule a fresh debounce timer) AND inside
  // the timer callback (so a timer already armed before `close()` was
  // called doesn't invoke `onChange` after the watcher is gone). The
  // belt-and-braces guard closes the race the PR review caught: pre-fix,
  // `close()` cleared `timer` and awaited `watcher.close()`, but a
  // chokidar event arriving DURING that await would arm a fresh timer
  // whose callback then ran `onChange()` against a now-closed server.
  let closed = false;
  const fire = (path: string): void => {
    if (closed) return;
    pending.add(path);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (closed) return;
      const changed = Array.from(pending);
      pending = new Set<string>();
      try {
        options.onChange(changed);
      } catch (err) {
        logger.warn(`onChange callback threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, debounceMs);
    timer.unref?.();
  };

  // Apply the optional include gate before arming the debounce. A
  // dropped event leaves any already-armed timer in place — a prior
  // qualifying event still reloads.
  const onEvent = (path: string): void => {
    if (options.shouldTrigger && !options.shouldTrigger(path)) return;
    fire(path);
  };

  // Subscribe to every file-changing event chokidar emits. We
  // intentionally don't subscribe to `'addDir'` / `'unlinkDir'` because
  // those fire for every nested directory chokidar discovers at
  // start-up; the surrounding `'add'` / `'unlink'` events are enough
  // for our purposes (a directory rename that doesn't change any file
  // contents shouldn't trigger a hot reload).
  watcher.on('add', onEvent);
  watcher.on('change', onEvent);
  watcher.on('unlink', onEvent);

  watcher.on('error', (err) => {
    logger.warn(
      `chokidar error: ${err instanceof Error ? err.message : String(err)}. ` +
        `--watch may be degraded for the remainder of this session — file changes ` +
        `may no longer trigger reloads. Restart cdkl to recover.`
    );
  });

  return {
    close: async (): Promise<void> => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await watcher.close();
    },
  };
}
