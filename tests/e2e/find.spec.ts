import { test, expect } from '@playwright/test';

/**
 * Guards the find-in-conversation *visibility* contract — which lives in real
 * CSS/layout and so cannot be exercised by the happy-dom unit tests:
 *
 *  - The find bar must paint ABOVE the chat header. Regression (v0.3.1): the
 *    header gained `position: relative; z-index: 20`, painting its opaque
 *    background over the find bar (z-index 10) so the bar mounted but was
 *    invisible. The bar now sits at z-index 30.
 *  - The active match must use a CSS highlight distinct from other matches.
 *
 * These run against the loaded app's real stylesheets by injecting the same DOM
 * structure the app renders, so they don't depend on a configured vault.
 */
test.describe('Find-in-conversation visibility contract', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:1420');
    await page.waitForLoadState('networkidle');
  });

  test('find bar paints above the conversation header', async ({ page }) => {
    const findBarIsOnTop = await page.evaluate(() => {
      const mp = document.createElement('div');
      mp.className = 'main-panel';
      mp.style.cssText = 'position:relative; width:600px; height:400px;';
      mp.innerHTML = `
        <div class="find-in-conversation"><input class="find-input" /></div>
        <div class="chat-interface" style="flex:1;display:flex;flex-direction:column;">
          <div class="item-header">HEADER</div>
        </div>`;
      document.body.appendChild(mp);
      const find = mp.querySelector('.find-in-conversation') as HTMLElement;
      const r = find.getBoundingClientRect();
      // Both the bar and the header occupy the top strip; whoever paints there wins.
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + 8);
      const onTop = hit ? find.contains(hit) || hit === find : false;
      mp.remove();
      return onTop;
    });
    expect(findBarIsOnTop).toBe(true);
  });

  test('find bar z-index is above the header z-index', async ({ page }) => {
    const z = await page.evaluate(() => {
      const zOf = (cls: string, extra = '') => {
        const el = document.createElement('div');
        el.className = cls;
        el.style.cssText = extra;
        document.body.appendChild(el);
        const value = parseInt(getComputedStyle(el).zIndex || '0', 10);
        el.remove();
        return Number.isNaN(value) ? 0 : value;
      };
      // .item-header only applies its z-index when positioned.
      return { find: zOf('find-in-conversation'), header: zOf('item-header', 'position:relative;') };
    });
    expect(z.find).toBeGreaterThan(z.header);
  });

  test('the active match has a highlight color distinct from other matches', async ({ page }) => {
    const colors = await page.evaluate(() => {
      let search = '';
      let current = '';
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue; // cross-origin sheet, skip
        }
        for (const rule of Array.from(rules) as CSSStyleRule[]) {
          if (rule.selectorText === '::highlight(search)') search = rule.style.backgroundColor;
          if (rule.selectorText === '::highlight(search-current)') current = rule.style.backgroundColor;
        }
      }
      return { search, current };
    });
    expect(colors.search).toBeTruthy();
    expect(colors.current).toBeTruthy();
    expect(colors.current).not.toBe(colors.search);
  });
});
