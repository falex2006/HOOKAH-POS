'use strict';

(function attachShiftCloseContract(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HOOKAH_SHIFT_CLOSE = api;
})(typeof globalThis === 'object' ? globalThis : null, () => {
  const checklistVersion = 1;
  const checklistItems = Object.freeze([
    Object.freeze({ id: 'ordersReviewed', label: 'Активные заказы проверены и завершены или переданы по регламенту.' }),
    Object.freeze({ id: 'cashCounted', label: 'Наличные пересчитаны; фактический остаток внесён и сверяется с ожидаемым.' }),
    Object.freeze({ id: 'inventoryReviewed', label: 'Складские операции смены проверены и завершены.' }),
    Object.freeze({ id: 'externalFiscalReportsHandled', label: 'Внешние X/Z-отчёты обработаны по регламенту точки или отмечены как неприменимые.' }),
  ]);

  const validateChecklist = (value) => {
    if (!value || value.version !== checklistVersion || !value.items || typeof value.items !== 'object' || Array.isArray(value.items)) return false;
    const requiredIds = checklistItems.map((item) => item.id).sort();
    const submittedIds = Object.keys(value.items).sort();
    return requiredIds.length === submittedIds.length
      && requiredIds.every((id, index) => submittedIds[index] === id && value.items[id] === true);
  };

  const freezeChecklist = (value, actorId, confirmedAt) => {
    if (!validateChecklist(value)) return null;
    return {
      version: checklistVersion,
      items: checklistItems.map((item) => ({ ...item, checked: true, checkedBy: actorId || null, checkedAt: confirmedAt })),
    };
  };

  const stableJsonStringify = (value) => {
    const normalize = (item) => {
      if (Array.isArray(item)) return item.map(normalize);
      if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]));
      return item;
    };
    return JSON.stringify(normalize(value));
  };

  return Object.freeze({ checklistVersion, checklistItems, validateChecklist, freezeChecklist, stableJsonStringify });
});
