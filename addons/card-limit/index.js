// Card limit addon: caps how many cards a single user can own.
// Enabled by setting CARD_LIMIT_PER_USER to a positive number.

function getLimit(env = process.env) {
  const limit = parseInt(env.CARD_LIMIT_PER_USER, 10);
  return Number.isInteger(limit) && limit > 0 ? limit : null;
}

// Whether userId may create one more card (slug = the card being created, if known)
async function canCreateCard(userId, slug, ctx) {
  const limit = getLimit();
  if (!limit) return true;
  if (slug) {
    const existing = await ctx.dbGet('SELECT 1 FROM cards WHERE slug = ? AND user_id = ?', [slug, userId]);
    if (existing) return true; // updating an existing card never counts against the limit
  }
  const row = await ctx.dbGet('SELECT COUNT(*) AS count FROM cards WHERE user_id = ?', [userId]);
  return row.count < limit;
}

module.exports = {
  name: 'card-limit',

  isEnabled(env) {
    return getLimit(env) !== null;
  },

  canCreateCard,

  async beforeCardSave({ targetUserId, slug }, ctx) {
    if (!(await canCreateCard(targetUserId, slug, ctx))) {
      const limit = getLimit();
      throw new ctx.addons.AddonError(403, `Card limit reached: each user can have at most ${limit} card${limit === 1 ? '' : 's'}`);
    }
  }
};
