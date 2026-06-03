#!/usr/bin/env node
// Headless `cdkl studio` GIF recorder.
//
// Boots `cdkl studio` against ./sample-app, drives the REAL browser UI through
// the API request-composer flow with Playwright (chromium headless), records a
// video, and converts it to ../cdkl-studio.gif via ffmpeg.
//
// Flow captured: expand the APIs group -> pick the HTTP API -> Start it ->
// compose a GET /hello request in the workspace -> Send -> the response renders
// inline AND a row lands on the timeline -> click the row for its detail.
//
// Prereqs: Docker running (Start boots a RIE container behind the API), the repo
// built (`vp run build` so dist/cli.js exists), ffmpeg on PATH, and Playwright
// installed. Playwright is a maintainer-only recorder dependency, NOT a
// committed devDependency (it would bloat every contributor's install for a
// demo tool), so install it on demand before re-recording:
//
//   pnpm add -D playwright && npx playwright install chromium
//
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const cli = join(repoRoot, 'dist', 'cli.js');
const sampleApp = join(here, 'sample-app');
const outGif = join(repoRoot, 'assets', 'cdkl-studio.gif');
const W = 1280;
// Deliberately short so the composer + response + streamed logs exceed the
// workspace pane height — the response/log transition then requires a real
// (and visible) scroll, instead of everything fitting on one screen.
const H = 640;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!existsSync(cli)) throw new Error('dist/cli.js missing — run `vp run build` first.');

  // Pre-pull the Lambda base image so Start is fast + the GIF is not padded by a
  // first-run docker pull.
  try {
    execFileSync('docker', ['pull', 'public.ecr.aws/lambda/nodejs:20'], { stdio: 'ignore' });
  } catch {
    /* image may already be cached / offline — proceed */
  }

  // 1. Boot studio against the sample app. (Do NOT lower the log level — the
  // "studio is running at <url>" line is logged at info.)
  const studio = spawn('node', [cli, 'studio', '--no-open', '--studio-port', '9777'], {
    cwd: sampleApp,
    env: { ...process.env },
  });
  let url = null;
  const grabUrl = (d) => {
    const m = String(d).match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+/);
    if (m && !url) url = m[0];
  };
  studio.stdout.on('data', (d) => {
    grabUrl(d);
    process.stdout.write('[studio] ' + d);
  });
  studio.stderr.on('data', (d) => {
    grabUrl(d);
    process.stderr.write('[studio] ' + d);
  });

  for (let i = 0; i < 120 && !url; i += 1) await wait(500);
  if (!url) {
    studio.kill('SIGKILL');
    throw new Error('studio did not report a URL within 60s');
  }
  await wait(1500);

  // 2. Record the UI flow.
  const videoDir = mkdtempSync(join(tmpdir(), 'cdkl-studio-vid-'));
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: videoDir, size: { width: W, height: H } },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(url);
  await wait(1200);

  // Playwright headless renders no OS cursor — inject a green dot that tracks
  // the mouse so the recording shows where clicks land.
  await page.evaluate(() => {
    const c = document.createElement('div');
    c.id = '__demo_cursor';
    c.style.cssText =
      'position:fixed;z-index:99999;width:16px;height:16px;border-radius:50%;' +
      'background:rgba(78,201,122,0.85);border:2px solid #6ff0a0;' +
      'box-shadow:0 0 10px rgba(78,201,122,0.9);pointer-events:none;' +
      'transform:translate(-50%,-50%);left:-60px;top:-60px;';
    document.body.appendChild(c);
    window.addEventListener(
      'mousemove',
      (e) => {
        c.style.left = e.clientX + 'px';
        c.style.top = e.clientY + 'px';
      },
      true
    );
  });

  // Move the green cursor to a locator's center (animated) and optionally click.
  const moveTo = async (loc) => {
    await loc.scrollIntoViewIfNeeded();
    const b = await loc.boundingBox();
    if (!b) throw new Error('no bounding box for locator');
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 24 });
    await wait(420);
    return b;
  };
  const click = async (loc) => {
    const b = await moveTo(loc);
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };
  const typeInto = async (loc, text) => {
    await click(loc);
    await page.keyboard.type(text, { delay: 55 });
  };

  await wait(700);
  // Expand the APIs group and pick the HTTP API.
  await click(page.locator('.group-title', { hasText: 'APIs' }));
  await wait(700);
  await click(page.locator('.target', { hasText: 'MyHttpApi' }).first());
  await wait(900);

  // Start the serve from the workspace.
  await click(page.locator('#workspace').getByRole('button', { name: 'Start', exact: true }));
  await page.locator('.req-composer').first().waitFor({ timeout: 90000 });
  await wait(1500);

  // Compose POST /echo with a header (KV) and a JSON body.
  await moveTo(page.locator('.req-method'));
  await page.locator('.req-method').selectOption('POST');
  await wait(500);
  // The path field defaults to '/', so clear it before typing — otherwise the
  // typed value appends to the default and the demo shows a doubled '//echo'.
  await page.locator('.req-path').fill('');
  await typeInto(page.locator('.req-path'), '/echo');
  await wait(500);
  await click(page.locator('.hdr-editor .pair-add'));
  await wait(400);
  await typeInto(page.locator('.hdr-editor .pair-row .pair-in').first(), 'X-Demo');
  await typeInto(page.locator('.hdr-editor .pair-row .pair-in').nth(1), 'studio');
  await wait(500);
  await typeInto(page.locator('.req-body'), '{ "name": "studio" }');
  await wait(700);

  // Send — the response renders inline AND lands on the timeline.
  await click(page.locator('.req-send button', { hasText: 'Send' }));
  await page.locator('.req-result .req-status').first().waitFor({ timeout: 30000 });
  // Hold on the inline response (status + reflected body) so it reads clearly.
  await wait(2600);

  // VISIBLY scroll the workspace down to reveal the streamed container logs.
  // A stepped wheel scroll (not an instant scrollIntoView) so the GIF actually
  // captures the scroll motion. Park the cursor over the workspace first so the
  // wheel targets that pane.
  const wsBox = await page.locator('#workspace').boundingBox();
  if (wsBox) {
    await page.mouse.move(wsBox.x + wsBox.width / 2, wsBox.y + wsBox.height / 2, { steps: 8 });
    await wait(300);
    for (let i = 0; i < 10; i += 1) {
      await page.mouse.wheel(0, 150);
      await wait(150);
    }
  }
  await wait(2200); // dwell on the logs

  // Open the captured request on the timeline to show it was captured.
  await click(page.locator('#timeline-rows .row').first());
  await wait(2600);

  await ctx.close();
  await browser.close();
  studio.kill('SIGTERM');
  await wait(3500);

  // 3. webm -> gif (two-pass palette for clean colors).
  const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'));
  if (!webm) throw new Error('no video captured');
  const webmPath = join(videoDir, webm);
  const palette = join(videoDir, 'palette.png');
  const fps = 12;
  const filters = `fps=${fps},scale=${W}:-1:flags=lanczos`;
  execFileSync('ffmpeg', ['-y', '-i', webmPath, '-vf', `${filters},palettegen=stats_mode=diff`, palette], {
    stdio: 'ignore',
  });
  execFileSync(
    'ffmpeg',
    ['-y', '-i', webmPath, '-i', palette, '-lavfi', `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3`, outGif],
    { stdio: 'ignore' }
  );
  rmSync(videoDir, { recursive: true, force: true });
  process.stdout.write(`\nWrote ${outGif}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
