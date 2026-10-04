// Health check addon: a lightweight endpoint for container orchestrators and
// monitoring. Enabled by HEALTHCHECK_PATH (e.g. /healthz).
// Returns 200 when the database answers, 503 otherwise. Not rate limited, so
// liveness/readiness probes can call it frequently.

module.exports = {
  name: 'health',

  isEnabled(env) {
    return /^\/[A-Za-z0-9_-][A-Za-z0-9/_-]*$/.test(env.HEALTHCHECK_PATH || '');
  },

  registerRoutes(app, ctx) {
    app.get(process.env.HEALTHCHECK_PATH, async (req, res) => {
      try {
        await ctx.dbGet('SELECT 1', []);
        res.set('Cache-Control', 'no-store').json({ status: 'ok' });
      } catch (err) {
        res.status(503).set('Cache-Control', 'no-store').json({ status: 'error' });
      }
    });
  }
};
