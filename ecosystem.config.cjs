// PM2 process definition for the live server.
//
// The bot runs the TypeScript source directly through tsx (`node --import tsx`)
// rather than a compiled dist/ bundle. This is deliberate: a previous deploy ran
// stale compiled JS because `git pull` updated src/ but the `tsc` build step was
// skipped, so the bot silently ran old code (the proactive follow-up feature never
// fired). With no build artifact there is nothing to drift out of sync — deploy is
// just `git pull` (+ `npm install` if deps changed) and a restart.
//
// App configuration lives in the server's .env (loaded by dotenv at startup). Do NOT
// add app config keys to the `env` block below: dotenv does not override variables
// already present in process.env, so anything set here would silently shadow .env.
//
// Deploy steps are documented in the `deploy-procedure` project memory.
module.exports = {
  apps: [
    {
      name: 'tg-ai-userbot',
      script: 'src/index.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      // Resolve relative to this file, so it works wherever the repo is checked out.
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
