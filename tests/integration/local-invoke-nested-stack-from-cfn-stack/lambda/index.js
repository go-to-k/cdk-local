exports.handler = async () => ({
  BUCKET: process.env.BUCKET || 'unset',
  QUEUE_URL: process.env.QUEUE_URL || 'unset',
  PARENT_BUCKET: process.env.PARENT_BUCKET || 'unset',
  ROOT_QUEUE: process.env.ROOT_QUEUE || 'unset',
});
