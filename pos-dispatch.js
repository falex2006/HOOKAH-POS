/* Shared station planning: a mixed order is two server-confirmed operations. */
(function (root) {
  'use strict';
  const stations = ['bar', 'hookah'];
  const eligibleItems = items => (items || []).filter(item =>
    (item.preparationStatus || 'new') === 'new' ||
    (!item.preparationStation && item.preparationStatus === 'queued'));

  function plan(items, choices = {}) {
    const groups = stations.map(station => ({ station, itemIds: [] }));
    for (const item of eligibleItems(items)) {
      const station = item.preparationStation || choices[String(item.id)];
      if (!stations.includes(station)) throw new Error('preparation_direction_required');
      groups.find(group => group.station === station).itemIds.push(String(item.id));
    }
    return groups.filter(group => group.itemIds.length);
  }

  async function send(groups, { isCurrent, post, onSaved }) {
    const completed = [];
    for (const group of groups) {
      if (!isCurrent()) return { completed, error: new Error('permissions_changed') };
      try {
        const saved = await post(group);
        if (!isCurrent()) return { completed, error: new Error('permissions_changed') };
        onSaved(saved);
        completed.push({ station: group.station, count: group.itemIds.length });
      } catch (error) {
        return { completed, error };
      }
    }
    return { completed, error: null };
  }
  root.HookahPosDispatch = Object.freeze({ eligibleItems, plan, send });
})(window);
