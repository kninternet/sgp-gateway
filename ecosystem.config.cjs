module.exports = {
  apps: [
    {
      name: 'sgp-gateway',
      script: 'dist/src/server.js',
      node_args: '--env-file=.env',
      env: { NODE_ENV: 'production', TZ: 'America/Sao_Paulo' },
      max_memory_restart: '200M',
    },
    {
      // Sync da base própria: roda a cada hora e encerra.
      name: 'sgp-gateway-sync',
      script: 'dist/src/sync.js',
      node_args: '--env-file=.env',
      env: { NODE_ENV: 'production', TZ: 'America/Sao_Paulo' },
      cron_restart: '0 * * * *',
      autorestart: false,
    },
  ],
};
