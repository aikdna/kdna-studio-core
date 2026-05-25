/**
 * I18N — Locale overlay creation, validation, and application.
 *
 * KDNA domains encode judgment. Localization changes language, not logic.
 * Overlays translate text fields by referencing canonical IDs.
 * Structural fields MUST NOT be changed by localization.
 */

const TEXT_FIELDS = ['one_sentence', 'full_statement', 'why', 'key_distinction', 'wrong', 'correct',
  'failure_risk', 'essence', 'boundary', 'trigger_signal', 'question', 'scope', 'out_of_scope'];
const ARRAY_TEXT_FIELDS = ['applies_when', 'does_not_apply_when', 'acceptable_exceptions'];

const VALID_LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'de'];

function createLocaleOverlay(project, locale) {
  if (!VALID_LOCALES.includes(locale)) throw new Error(`Invalid locale: ${locale}`);

  const overlay = { locale, base: 'en', spec_version: '1.0-rc', translations: {} };
  const cards = project.cards || [];

  for (const card of cards) {
    if (!card.locked) continue;
    const fields = card.fields || {};

    for (const field of TEXT_FIELDS) {
      if (fields[field] && typeof fields[field] === 'string' && fields[field].length > 3) {
        overlay.translations[`${card.id}.${field}`] = `[TODO: ${locale}] ${fields[field]}`;
      }
    }
    for (const field of ARRAY_TEXT_FIELDS) {
      if (Array.isArray(fields[field])) {
        fields[field].forEach((val, idx) => {
          if (val && typeof val === 'string') {
            overlay.translations[`${card.id}.${field}.${idx}`] = `[TODO: ${locale}] ${val}`;
          }
        });
      }
    }
  }

  return overlay;
}

function validateLocaleOverlay(project, overlay) {
  const issues = [];
  const cards = project.cards || [];
  const cardIds = new Set(cards.map(c => c.id));

  if (!overlay.locale) issues.push({ type: 'missing_locale', severity: 'blocking', message: 'Overlay must declare locale' });
  if (!overlay.translations || Object.keys(overlay.translations).length === 0) {
    issues.push({ type: 'empty', severity: 'warning', message: 'Overlay has no translations' });
    return { valid: false, issues };
  }

  // Validate referenced IDs exist
  for (const key of Object.keys(overlay.translations)) {
    const cardId = key.split('.')[0];
    if (!cardIds.has(cardId)) {
      issues.push({ type: 'unknown_id', severity: 'blocking', message: `Overlay references unknown card: ${cardId}` });
    }
  }

  // Check for TODO placeholders
  const todoCount = Object.values(overlay.translations).filter(v => v.includes('[TODO:')).length;
  if (todoCount > 0) {
    issues.push({ type: 'incomplete', severity: 'warning', message: `${todoCount} translations still have TODO placeholders` });
  }

  return { valid: issues.filter(i => i.severity === 'blocking').length === 0, issues };
}

function applyLocaleOverlay(domainFiles, overlay) {
  if (!overlay || !overlay.translations) return domainFiles;
  const localized = { ...domainFiles };

  for (const [filename, content] of Object.entries(localized)) {
    if (!filename.startsWith('KDNA_')) continue;
    try {
      const data = JSON.parse(content);
      applyOverlayToObject(data, overlay.translations);
      localized[filename] = JSON.stringify(data, null, 2);
    } catch { /* skip non-JSON */ }
  }

  return localized;
}

function applyOverlayToObject(obj, translations, prefix = '') {
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof obj[key] === 'string') {
      if (translations[fullKey] && !translations[fullKey].includes('[TODO:')) {
        obj[key] = translations[fullKey];
      }
    } else if (Array.isArray(obj[key])) {
      if (obj[key].every(v => typeof v === 'string')) {
        obj[key] = obj[key].map((v, i) => {
          const arrayKey = `${fullKey}.${i}`;
          return (translations[arrayKey] && !translations[arrayKey].includes('[TODO:')) ? translations[arrayKey] : v;
        });
      } else {
        obj[key].forEach((item, i) => {
          if (typeof item === 'object' && item !== null) {
            applyOverlayToObject(item, translations, `${fullKey}.${i}`);
          } else if (item && item.id) {
            applyOverlayToObject(item, translations, `${fullKey}.${i}`);
          }
        });
      }
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      applyOverlayToObject(obj[key], translations, fullKey);
    }
  }
}

function computeI18nCoverage(project) {
  const cards = project.cards || [];
  const locked = cards.filter(c => c.locked);
  if (locked.length === 0) return { level: 'L0', coverage: 0, translatable_fields: 0 };

  const totalFields = locked.reduce((sum, c) => {
    const fields = c.fields || {};
    let count = 0;
    for (const f of TEXT_FIELDS) { if (fields[f] && typeof fields[f] === 'string') count++; }
    for (const f of ARRAY_TEXT_FIELDS) { if (Array.isArray(fields[f])) count += fields[f].filter(v => typeof v === 'string').length; }
    return sum + count;
  }, 0);

  // Check overlay for actual translation completion
  const overlay = project.i18n_overlay || {};
  const translations = overlay.translations || {};
  const translatedCount = Object.values(translations).filter(v => typeof v === 'string' && !v.includes('[TODO:')).length;

  const coverage = totalFields > 0 ? Math.round((translatedCount / totalFields) * 100) : 0;

  let level = 'L0';
  if (totalFields > 0) level = 'L1'; // Has translatable content
  if (coverage >= 30) level = 'L2';  // Key fields covered
  if (coverage >= 70) level = 'L3';  // Full coverage
  if (coverage >= 90 && (project.tests || []).length >= 5) level = 'L4'; // Full coverage + evals

  return { level, coverage: Math.min(100, coverage), translatable_fields: totalFields, translated_fields: translatedCount };
}

module.exports = { createLocaleOverlay, validateLocaleOverlay, applyLocaleOverlay, computeI18nCoverage, VALID_LOCALES };
