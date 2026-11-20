import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CATALOGS, detectLocale, formatTimeAgo, translate, type Locale } from '../web/src/lib/i18n.ts';
import { en, type PluralMessage } from '../web/src/locales/en.ts';

const placeholders = (message: string | PluralMessage) => {
  const texts = typeof message === 'string' ? [message] : Object.values(message);
  return [...new Set(texts.flatMap((text) => [...(text ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1])))].sort();
};

describe('message catalogs', () => {
  const others = Object.entries(CATALOGS).filter(([locale]) => locale !== 'en') as [Locale, Record<string, string | PluralMessage>][];

  for (const [locale, catalog] of others) {
    it(`${locale} has exactly the English keys`, () => {
      assert.deepEqual(Object.keys(catalog).sort(), Object.keys(en).sort());
    });

    it(`${locale} messages use the same placeholders and plural shape as English`, () => {
      for (const [key, source] of Object.entries(en) as [string, string | PluralMessage][]) {
        const message = catalog[key];
        assert.equal(typeof message, typeof source, `${key}: plural vs plain string`);
        assert.ok(String(typeof message === 'string' ? message : message.other).trim(), `${key}: empty`);
        assert.deepEqual(placeholders(message), placeholders(source), `${key}: placeholders differ`);
      }
    });
  }

  it('no message uses {key}, which <Trans> reserves for the message key', () => {
    for (const [key, message] of Object.entries(en)) assert.ok(!placeholders(message).includes('key'), key);
  });
});

describe('translate', () => {
  it('interpolates and localizes numbers', () => {
    assert.equal(translate('en', 'addPrinter.connectTo', { name: 'X1C' }), 'Connect to X1C');
    assert.equal(translate('en', 'unit.kb', { value: 1.5 }), '1.5 KB');
    assert.equal(translate('fr', 'unit.kb', { value: 1.5 }), '1,5\u00a0Ko'); // no-break space before the unit
  });

  it('picks plural forms with Intl.PluralRules', () => {
    assert.equal(translate('en', 'printers.alerts', { count: 1 }), '1 alert');
    assert.equal(translate('en', 'printers.alerts', { count: 2 }), '2 alerts');
    // French uses the singular for 0 and 1.
    assert.equal(translate('fr', 'printers.alerts', { count: 0 }), '0 alerte');
    assert.equal(translate('fr', 'printers.alerts', { count: 3 }), '3 alertes');
  });

  it('leaves unknown placeholders untouched', () => {
    assert.equal(translate('en', 'addPrinter.connectTo'), 'Connect to {name}');
  });

  it('formats relative times', () => {
    const now = Date.UTC(2026, 0, 1);
    assert.equal(formatTimeAgo(now - 5 * 60_000, now, 'en'), '5 minutes ago');
    assert.equal(formatTimeAgo(now - 3 * 3_600_000, now, 'fr'), 'il y a 3 heures');
  });
});

describe('detectLocale', () => {
  it('prefers the saved choice', () => {
    assert.equal(detectLocale('fr', ['en-US']), 'fr');
    assert.equal(detectLocale('en', ['fr-FR']), 'en');
  });

  it('follows the first supported browser language, English otherwise', () => {
    assert.equal(detectLocale(null, ['fr-CA', 'en']), 'fr');
    assert.equal(detectLocale(null, ['en-GB', 'fr']), 'en');
    assert.equal(detectLocale(null, ['de-DE', 'fr']), 'fr');
    assert.equal(detectLocale(null, ['de-DE']), 'en');
    assert.equal(detectLocale('xx', []), 'en');
  });
});
