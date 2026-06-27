const assert = require('node:assert/strict');

function decodeEntities(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function setupBrowserStub(hash) {
  global.window = {
    location: { hash: hash || '#/' },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    addEventListener: () => {},
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: false }),
    CSS: {
      escape: (value) => String(value),
    },
  };
  global.document = {
    readyState: 'loading',
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => {
      let text = '';
      return {
        set innerHTML(value) {
          text = decodeEntities(value).replace(/<[^>]*>/g, '');
        },
        get textContent() {
          return text;
        },
      };
    },
    body: {
      appendChild: () => {},
      classList: { add: () => {} },
    },
    documentElement: {
      style: { setProperty: () => {} },
    },
  };
}

function loadSidebarForTest(hash) {
  setupBrowserStub(hash);
  delete require.cache[require.resolve('../app/dpr-sidebar.js')];
  return require('../app/dpr-sidebar.js');
}

const sampleSidebar = `
* <a class="dpr-sidebar-root-link" href="#/">首页</a>
* <a class="dpr-sidebar-root-link" href="#/tutorial/README">使用教程</a>

* Conference Papers
  * NEURIPS 2024 <!--dpr-conference:neurips-2024-->
    * rl <!--dpr-conference-topic:neurips-2024:query-rl-->
      * <a class="dpr-sidebar-item-link dpr-sidebar-item-structured" href="#/conference/neurips-2024/paper-c" data-sidebar-item="{&quot;title&quot;:&quot;Paper C&quot;,&quot;score&quot;:&quot;9.0&quot;}">Fallback C</a>

* Daily Papers
  * 2026-06-24 <!--dpr-date:20260624-->
    * 精读区
      * <a class="dpr-sidebar-item-link dpr-sidebar-item-structured" href="#/202606/24/paper-a" data-sidebar-item="{&quot;title&quot;:&quot;Paper A&quot;,&quot;score&quot;:&quot;10.0&quot;}">Fallback A</a>
    * 速读区
      * <a class="dpr-sidebar-item-link dpr-sidebar-item-structured" href="#/202606/24/paper-b" data-sidebar-item="{&quot;title&quot;:&quot;Paper B&quot;,&quot;score&quot;:&quot;8.0&quot;}">Fallback B</a>
`;

function testSidebarNavigationContract() {
  const sidebar = loadSidebarForTest('#/202606/24/paper-b?from=test');
  const tools = sidebar.__test;
  assert.ok(tools, 'dpr-sidebar.js should export test helpers');
  assert.equal(typeof tools.parseSidebar, 'function');

  const model = tools.parseSidebar(sampleSidebar);
  assert.deepEqual(tools.collectPaperHrefsFromModel(model), [
    '#/202606/24/paper-a',
    '#/202606/24/paper-b',
    '#/conference/neurips-2024/paper-c',
  ]);
  assert.deepEqual(tools.collectReportHrefsFromModel(model), [
    '#/202606/24/README',
  ]);
  assert.equal(
    tools.findCurrentPaperHrefFromModel(model, '#/202606/24/paper-b?from=test'),
    '#/202606/24/paper-b',
  );
  assert.equal(
    tools.findCurrentReportHrefFromModel(model, '#/202606/24/README'),
    '#/202606/24/README',
  );
}

function testReadStatusNormalization() {
  const sidebar = loadSidebarForTest('#/202606/24/paper-a');
  const tools = sidebar.__test;
  assert.ok(tools, 'dpr-sidebar.js should export test helpers');
  assert.equal(tools.normalizeReadStatus('good'), 'good');
  assert.equal(tools.normalizeReadStatus('bad'), 'bad');
  assert.equal(tools.normalizeReadStatus('blue'), 'blue');
  assert.equal(tools.normalizeReadStatus('orange'), 'orange');
  assert.equal(tools.normalizeReadStatus('read'), 'read');
  assert.equal(tools.normalizeReadStatus(true), 'read');
  assert.equal(tools.normalizeReadStatus(false), '');
  assert.equal(tools.normalizeReadStatus(null), '');
}

testSidebarNavigationContract();
testReadStatusNormalization();

console.log('dpr sidebar v2 tests passed');
