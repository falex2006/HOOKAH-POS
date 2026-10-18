/* Header-only presentation; never rewrite the stored identity. */
(() => {
  const normalize = (value) => String(value || '').trim().replace(/\s+/g, ' ');
  // Broad -ин/-ина rules also match given names; leave those ambiguous pairs intact.
  const looksLikeSurname = (value) => value.toLocaleLowerCase('ru-RU') !== 'лев' && /(?:ов|ев|ёв|ский|цкий|ова|ева|ёва|ская|цкая)$/iu.test(value);
  window.HookahStaffDisplayName = (user = {}) => {
    const full = normalize(user.name || user.fullName) || 'Сотрудник';
    if (['owner', 'admin', 'manager', 'developer'].includes(user.role)) return full;
    const explicit = normalize(user.firstName || user.givenName);
    if (explicit) return explicit;
    const parts = full.split(' ');
    if (parts.length === 3 && /(?:вич|вна|ична)$/iu.test(parts[2])) return parts[1];
    if (parts.length === 2) {
      const firstIsSurname = looksLikeSurname(parts[0]);
      const lastIsSurname = looksLikeSurname(parts[1]);
      if (firstIsSurname !== lastIsSurname) return firstIsSurname ? parts[1] : parts[0];
    }
    return full;
  };
})();
