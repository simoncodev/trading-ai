module.exports = {
  apps: [
    {
      name: 'trading-bot',
      script: 'dist/index.js',
      args: 'trade',
      cwd: '/srv/trading-ai',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
