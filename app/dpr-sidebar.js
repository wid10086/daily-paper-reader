/**
 * DPR Sidebar v2 — 自建侧边栏，替代 docsify 内置 sidebar
 *
 * 数据源：docs/_sidebar.md（仍由 src/6.generate_docs.py 和 src/conference_sidebar.py 维护）
 * 解析：直接读取条目 <a data-sidebar-item="..."> 上的 JSON payload
 *
 * UI：
 *   - 顶部工具条：[全部 / 未读] segmented control + 搜索框（debounce 200ms）
 *   - 主体：日报（按日期分组，默认只展开当前日）+ 会议（默认全部折叠）
 *   - 阅读状态接入 window.DPRReadStateSync（Supabase）或 localStorage 回退
 *   - hashchange → syncActive() 高亮 + 滚动居中
 */
(function () {
  'use strict';

  // ---------- 常量 ----------
  var SIDEBAR_URL = 'docs/_sidebar.md';
  var READ_STORAGE_KEY = 'dpr_read_papers_v1';
  var REFRESH_AFTER_HIDDEN_MS = 5 * 60 * 1000;
  var SEARCH_DEBOUNCE_MS = 200;
  var FILTER_KEY = 'dpr_sidebar_filter_v2';
  var COLLAPSE_KEY = 'dpr_sidebar_collapse_v2';

  // ---------- 工具 ----------
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function safeAttr(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function safeText(value) {
    var d = document.createElement('div');
    d.textContent = String(value == null ? '' : value);
    return d.innerHTML;
  }
  function debounce(fn, wait) {
    var t = null;
    return function () {
      var args = arguments;
      var ctx = this;
      window.clearTimeout(t);
      t = window.setTimeout(function () {
        fn.apply(ctx, args);
      }, wait);
    };
  }
  function decodeHtmlEntities(s) {
    var d = document.createElement('div');
    d.innerHTML = String(s == null ? '' : s);
    return d.textContent || '';
  }
  function parseScore(raw) {
    var n = parseFloat(raw);
    if (!isFinite(n)) return null;
    return n;
  }
  function starHtmlFromScore(score) {
    var s = parseScore(score);
    if (s == null) return '';
    var filled = Math.max(0, Math.min(5, Math.round(s / 2)));
    var stars = '';
    for (var i = 0; i < 5; i++) {
      stars += i < filled ? '★' : '☆';
    }
    return '<span class="dpr-sidebar-paper-stars" data-score="' + safeAttr(s.toFixed(1)) + '">' + stars + '</span>';
  }
  function tagsHtml(tags) {
    if (!Array.isArray(tags) || !tags.length) return '';
    return tags
      .map(function (t) {
        if (!t || typeof t !== 'object') return '';
        var kind = String(t.kind || 'query');
        var label = String(t.label || '');
        if (!label) return '';
        return '<span class="dpr-sidebar-paper-tag dpr-sidebar-paper-tag-' + safeAttr(kind) + '">' + safeText(label) + '</span>';
      })
      .join('');
  }
  function formatDateLabel(yyyymmdd) {
    var s = String(yyyymmdd || '');
    if (/^\d{8}$/.test(s)) {
      return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
    }
    return s;
  }
  function paperIdFromHref(href) {
    var s = String(href || '');
    s = s.replace(/^#\//, '').replace(/^\/+/, '');
    if (!s) return '';
    return s;
  }
  function normalizeRouteHref(href) {
    var h = String(href || '').trim();
    if (!h) return '';
    var idx = h.indexOf('?');
    if (idx >= 0) h = h.slice(0, idx);
    if (h.startsWith('#/')) return h;
    if (h.startsWith('#')) return '#/' + h.slice(1).replace(/^\//, '');
    return '#/' + h.replace(/^\//, '');
  }
  function dayReportHrefFromKey(dateKey, explicitHref) {
    var explicit = normalizeRouteHref(explicitHref || '');
    if (explicit && !/^#\/javascript:/i.test(explicit)) return explicit;
    var key = String(dateKey || '').trim();
    if (/^\d{8}$/.test(key)) {
      return '#/' + key.slice(0, 6) + '/' + key.slice(6, 8) + '/README';
    }
    if (/^\d{8}-\d{8}$/.test(key)) {
      return '#/' + key + '/README';
    }
    return '';
  }
  function collectPaperHrefsFromModel(model) {
    var out = [];
    var m = model || state.model || {};
    (m.daily || []).forEach(function (day) {
      (day.papers || []).forEach(function (paper) {
        if (paper && paper.href) out.push(normalizeRouteHref(paper.href));
      });
    });
    (m.conferences || []).forEach(function (conf) {
      (conf.topics || []).forEach(function (topic) {
        (topic.papers || []).forEach(function (paper) {
          if (paper && paper.href) out.push(normalizeRouteHref(paper.href));
        });
      });
    });
    return out.filter(Boolean);
  }
  function collectReportHrefsFromModel(model) {
    var out = [];
    var m = model || state.model || {};
    (m.daily || []).forEach(function (day) {
      var href = day && (day.reportHref || dayReportHrefFromKey(day.dateKey));
      if (href) out.push(normalizeRouteHref(href));
    });
    return out.filter(Boolean);
  }
  function findCurrentPaperHrefFromModel(model, href) {
    var current = normalizeRouteHref(href || currentRouteHref());
    return collectPaperHrefsFromModel(model).indexOf(current) >= 0 ? current : '';
  }
  function findCurrentReportHrefFromModel(model, href) {
    var current = normalizeRouteHref(href || currentRouteHref());
    return collectReportHrefsFromModel(model).indexOf(current) >= 0 ? current : '';
  }
  function normalizeReadStatus(value) {
    if (value === true || value === 'read') return 'read';
    if (value === 'good' || value === 'bad' || value === 'blue' || value === 'orange') return value;
    return '';
  }

  // ---------- 阅读状态（包一层，方便切换 Supabase / localStorage） ----------
  var ReadState = {
    getAll: function () {
      if (window.DPRReadStateSync && window.DPRReadStateSync.isActive && window.DPRReadStateSync.isActive()) {
        return window.DPRReadStateSync.getAll() || {};
      }
      try {
        var raw = window.localStorage && window.localStorage.getItem(READ_STORAGE_KEY);
        if (!raw) return {};
        var obj = JSON.parse(raw);
        return obj && typeof obj === 'object' ? obj : {};
      } catch (e) {
        return {};
      }
    },
    isRead: function (paperId) {
      if (!paperId) return false;
      return !!normalizeReadStatus(this.getAll()[paperId]);
    },
  };

  // ---------- 数据解析 ----------
  // 把 docs/_sidebar.md 文本解析成 model
  // 结构：
  //   - 行 "* Daily Papers" 进入日报分组
  //   - 行 "  * <YYYY-MM-DD>  <!--dpr-date:YYYYMMDD-->" 是日期标题
  //   - 行 "    * 精读区 / 速读区" 是 section
  //   - 行 "      * <a class=dpr-sidebar-item-link href=#/.. data-sidebar-item={...}>..." 是论文
  //   - 行 "* Conference Papers" 进入会议分组
  //   - 行 "  * <CONF YYYY...>  <!--dpr-conference:xxx-->" 是会议块
  //   - 行 "    * <topic-label>  <!--dpr-conference-topic:...-->" 是 topic
  //   - 同样 "      * <a ...>" 是论文
  function parseSidebar(text) {
    var lines = String(text || '').split(/\r?\n/);
    var model = {
      home: null,
      tutorial: null,
      daily: [],
      conferences: [],
    };

    var i = 0;
    function parseTopLink(line) {
      // 顶层链接 line: "* <a ... href="#/" >首页</a>"
      var m = line.match(/href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!m) return null;
      var hashMatch = line.match(/data-dpr-hash="([^"]+)"/);
      return { href: hashMatch ? hashMatch[1] : m[1], label: stripTags(m[2]) };
    }
    function stripTags(html) {
      var d = document.createElement('div');
      d.innerHTML = String(html || '');
      return (d.textContent || '').trim();
    }
    function parsePaperLine(line) {
      var m = line.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/);
      if (!m) return null;
      var attrStr = m[1];
      var title = stripTags(m[2]);
      var hrefMatch = attrStr.match(/href="([^"]+)"/);
      var href = hrefMatch ? hrefMatch[1] : '';
      if (!href || !/^#\//.test(href)) return null;
      var payloadMatch = attrStr.match(/data-sidebar-item="([^"]*)"/);
      var payload = null;
      if (payloadMatch && payloadMatch[1]) {
        try {
          payload = JSON.parse(decodeHtmlEntities(payloadMatch[1]));
        } catch (e) {
          payload = null;
        }
      }
      var paperId = paperIdFromHref(href);
      var node = {
        id: paperId,
        href: href,
        title: (payload && payload.title) || title || paperId,
        link: (payload && payload.link) || '',
        score: payload && payload.score,
        evidence: (payload && payload.evidence) || '',
        tags: (payload && Array.isArray(payload.tags) ? payload.tags : []),
        selectionSource: payload && payload.selection_source,
      };
      return node;
    }

    while (i < lines.length) {
      var line = lines[i];
      var trimmed = line.replace(/\s+$/, '');
      if (!trimmed) { i += 1; continue; }

      // 顶层入口（首页/教程）
      if (/^\*\s+<a\b/.test(trimmed) && i < 3) {
        var top = parseTopLink(trimmed);
        if (top) {
          if (!model.home && (top.href === '#/' || /\/$/.test(top.href))) {
            model.home = top;
          } else if (!model.tutorial) {
            model.tutorial = top;
          }
        }
        i += 1;
        continue;
      }

      if (/^\*\s*Daily Papers/.test(trimmed)) {
        i += 1;
        while (i < lines.length && !/^\*\s/.test(lines[i])) {
          var dayLine = lines[i];
          var markerMatch = dayLine.match(/<!--dpr-date:(\d+)-->/);
          if (/^\s{2}\*\s/.test(dayLine) && !/^\s{4}/.test(dayLine)) {
            var dayLink = parseTopLink(dayLine);
            var rawLabel = dayLine.replace(/^\s{2}\*\s+/, '').replace(/<!--.*?-->/g, '').trim();
            var dateKey = markerMatch ? markerMatch[1] : rawLabel;
            var day = {
              dateKey: dateKey,
              dateLabel: (dayLink && dayLink.label) || rawLabel || (markerMatch ? formatDateLabel(markerMatch[1]) : ''),
              reportHref: dayReportHrefFromKey(dateKey, dayLink && dayLink.href),
              papers: [],
            };
            i += 1;
            var currentSection = 'deep';
            // 收到下一行不是当前 day 的子节点（缩进 >=4）则跳出
            while (i < lines.length) {
              var inner = lines[i];
              if (/^\*\s/.test(inner) || /^\s{0,3}\*\s/.test(inner)) break;
              if (!inner.trim()) { i += 1; continue; }
              // section heading 4-space "* 精读区/速读区"
              if (/^\s{4}\*\s+精读区/.test(inner)) {
                currentSection = 'deep';
                i += 1;
                continue;
              }
              if (/^\s{4}\*\s+速读区/.test(inner)) {
                currentSection = 'quick';
                i += 1;
                continue;
              }
              // paper at 6-space indent (生产格式：分 section)
              if (/^\s{6}\*\s+<a/.test(inner)) {
                var paper = parsePaperLine(inner);
                if (paper) {
                  paper.section = currentSection;
                  day.papers.push(paper);
                }
                i += 1;
                continue;
              }
              // paper at 4-space indent (无 section 简化格式)
              if (/^\s{4}\*\s+<a/.test(inner)) {
                var paper2 = parsePaperLine(inner);
                if (paper2) {
                  paper2.section = currentSection;
                  day.papers.push(paper2);
                }
                i += 1;
                continue;
              }
              i += 1;
            }
            model.daily.push(day);
            continue;
          }
          i += 1;
        }
        continue;
      }

      if (/^\*\s*Conference Papers/.test(trimmed)) {
        i += 1;
        while (i < lines.length && !/^\*\s/.test(lines[i])) {
          var confLine = lines[i];
          var confMarker = confLine.match(/<!--dpr-conference:([^-]+)-(.+?)-->/);
          if (/^\s{2}\*\s/.test(confLine) && !/^\s{4}/.test(confLine)) {
            var confLabel = confLine.replace(/^\s{2}\*\s+/, '').replace(/<!--.*?-->/g, '').trim();
            var confBlock = {
              name: confMarker ? confMarker[1] : confLabel,
              years: confMarker ? confMarker[2] : '',
              label: confLabel,
              topics: [],
            };
            i += 1;
            var topic = null;
            while (i < lines.length) {
              var tLine = lines[i];
              if (/^\*\s/.test(tLine) || /^\s{0,3}\*\s/.test(tLine)) break;
              if (!tLine.trim()) { i += 1; continue; }
              // topic heading 4-space "* <label>" 但不是 paper 链接
              if (/^\s{4}\*\s+(?!<a)/.test(tLine)) {
                var topicLabel = tLine.replace(/^\s{4}\*\s+/, '').replace(/<!--.*?-->/g, '').trim();
                topic = { label: topicLabel || 'General', papers: [] };
                confBlock.topics.push(topic);
                i += 1;
                continue;
              }
              // paper at 6-space indent
              if (/^\s{6}\*\s+<a/.test(tLine)) {
                if (!topic) {
                  topic = { label: 'General', papers: [] };
                  confBlock.topics.push(topic);
                }
                var p = parsePaperLine(tLine);
                if (p) {
                  p.section = 'conference';
                  topic.papers.push(p);
                }
                i += 1;
                continue;
              }
              // paper at 4-space indent (无 topic)
              if (/^\s{4}\*\s+<a/.test(tLine)) {
                if (!topic) {
                  topic = { label: 'General', papers: [] };
                  confBlock.topics.push(topic);
                }
                var pp = parsePaperLine(tLine);
                if (pp) {
                  pp.section = 'conference';
                  topic.papers.push(pp);
                }
                i += 1;
                continue;
              }
              i += 1;
            }
            model.conferences.push(confBlock);
            continue;
          }
          i += 1;
        }
        continue;
      }

      i += 1;
    }

    // 日报按日期倒序
    model.daily.sort(function (a, b) {
      return String(b.dateKey).localeCompare(String(a.dateKey));
    });

    return model;
  }

  // ---------- 状态 ----------
  var state = {
    model: { home: null, tutorial: null, daily: [], conferences: [] },
    rootEl: null,
    bodyEl: null,
    searchInput: null,
    unreadCountEl: null,
    filter: 'all', // 'all' | 'unread'
    search: '',
    lastFetchAt: 0,
    expandedDates: null, // Set<dateKey>
    expandedConfs: null, // Set<confLabel>
  };

  function loadPersistedFilter() {
    try {
      var v = window.localStorage && window.localStorage.getItem(FILTER_KEY);
      return v === 'unread' ? 'unread' : 'all';
    } catch (e) {
      return 'all';
    }
  }
  function persistFilter() {
    try {
      window.localStorage && window.localStorage.setItem(FILTER_KEY, state.filter);
    } catch (e) {}
  }
  function loadPersistedCollapse() {
    try {
      var raw = window.localStorage && window.localStorage.getItem(COLLAPSE_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      return {
        expandedDates: Array.isArray(obj.dates) ? new Set(obj.dates) : null,
        expandedConfs: Array.isArray(obj.confs) ? new Set(obj.confs) : null,
      };
    } catch (e) {
      return null;
    }
  }
  function persistCollapse() {
    try {
      var payload = {
        dates: state.expandedDates ? Array.prototype.slice.call(state.expandedDates) : [],
        confs: state.expandedConfs ? Array.prototype.slice.call(state.expandedConfs) : [],
      };
      window.localStorage && window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(payload));
    } catch (e) {}
  }

  // ---------- 路由 / active ----------
  function currentRouteHref() {
    return normalizeRouteHref(window.location.hash || '#/');
  }
  function findActivePaper() {
    var href = currentRouteHref();
    return href || '';
  }

  // ---------- 渲染 ----------
  function ensureRoot() {
    var existing = $('#dpr-sidebar-v2');
    if (existing) return existing;
    var aside = document.createElement('aside');
    aside.id = 'dpr-sidebar-v2';
    aside.className = 'dpr-sidebar';
    document.body.appendChild(aside);
    document.body.classList.add('dpr-sidebar-v2');
    return aside;
  }

  // docsify 主题会把渲染到 <nav> 上的 .app-nav 当成顶部导航栏，
  // 进而触发 `.app-nav li ul{position:absolute;...}` 等下拉菜单规则，
  // 会破坏侧边栏内 ul/li 的正常流式布局。挂载后剥离这两类名。
  function stripAppNav(node) {
    if (!node || !node.classList) return;
    node.classList.remove('app-nav', 'no-badge');
  }

  function renderShell(root) {
    var homeHref = (state.model.home && state.model.home.href) || '#/';
    var tutorialHref = (state.model.tutorial && state.model.tutorial.href) || '#/tutorial/README';
    var homeLabel = (state.model.home && state.model.home.label) || '首页';
    var tutorialLabel = (state.model.tutorial && state.model.tutorial.label) || '使用教程';
    var filterAllActive = state.filter === 'all' ? 'is-active' : '';
    var filterUnreadActive = state.filter === 'unread' ? 'is-active' : '';
    root.innerHTML =
      '<button type="button" class="dpr-sidebar-mobile-toggle" aria-label="切换侧边栏">' +
      '<span></span><span></span><span></span></button>' +
      '<header class="dpr-sidebar-header">' +
      '  <a class="dpr-sidebar-quick dpr-sidebar-quick-home" href="' + safeAttr(homeHref) + '"><span>🏠</span>' + safeText(homeLabel) + '</a>' +
      '  <a class="dpr-sidebar-quick dpr-sidebar-quick-tutorial" href="' + safeAttr(tutorialHref) + '"><span>📖</span>' + safeText(tutorialLabel) + '</a>' +
      '</header>' +
      '<div class="dpr-sidebar-toolbar">' +
      '  <div class="dpr-sidebar-search-wrap">' +
      '    <span class="dpr-sidebar-search-icon" aria-hidden="true">🔍</span>' +
      '    <input type="search" class="dpr-sidebar-search" placeholder="搜索标题 / 摘要 / 标签" autocomplete="off" spellcheck="false" />' +
      '  </div>' +
      '  <div class="dpr-sidebar-filter" role="tablist">' +
      '    <button type="button" class="dpr-sidebar-filter-btn ' + filterAllActive + '" data-filter="all">全部</button>' +
      '    <button type="button" class="dpr-sidebar-filter-btn ' + filterUnreadActive + '" data-filter="unread">未读 <span class="dpr-sidebar-unread-count" data-count="0">0</span></button>' +
      '  </div>' +
      '</div>' +
      '<nav class="dpr-sidebar-body" aria-label="论文导航"></nav>' +
      '<div class="dpr-sidebar-footer">' +
      '  <button type="button" class="dpr-sidebar-refresh" title="刷新侧边栏">↻ 刷新</button>' +
      '</div>';
    state.bodyEl = $('.dpr-sidebar-body', root);
    state.searchInput = $('.dpr-sidebar-search', root);
    state.unreadCountEl = $('.dpr-sidebar-unread-count', root);
    // 渲染后立刻剥离 docsify 注入的 .app-nav / .no-badge（防下拉菜单定位）
    stripAppNav(state.bodyEl);
  }

  function renderBody() {
    var html = [];
    // Daily 组
    if (state.model.daily.length) {
      html.push('<section class="dpr-sidebar-group dpr-sidebar-group-daily">');
      html.push('<h3 class="dpr-sidebar-group-title">📅 日报</h3>');
      html.push('<ul class="dpr-sidebar-group-list">');
      state.model.daily.forEach(function (day) {
        html.push(renderDay(day));
      });
      html.push('</ul></section>');
    }
    // Conference 组
    if (state.model.conferences.length) {
      html.push('<section class="dpr-sidebar-group dpr-sidebar-group-conference">');
      html.push('<h3 class="dpr-sidebar-group-title">🏛️ 会议论文</h3>');
      html.push('<ul class="dpr-sidebar-group-list">');
      state.model.conferences.forEach(function (conf) {
        html.push(renderConference(conf));
      });
      html.push('</ul></section>');
    }
    state.bodyEl.innerHTML = html.join('');
  }

  function renderDay(day) {
    var expanded = state.expandedDates && state.expandedDates.has(day.dateKey);
    var label = day.dateLabel || formatDateLabel(day.dateKey);
    var out = [];
    out.push('<li class="dpr-sidebar-day' + (expanded ? ' is-expanded' : '') + '" data-date="' + safeAttr(day.dateKey) + '">');
    out.push('  <button type="button" class="dpr-sidebar-day-header" aria-expanded="' + (expanded ? 'true' : 'false') + '">');
    out.push('    <span class="dpr-sidebar-day-arrow" aria-hidden="true">▸</span>');
    out.push('    <span class="dpr-sidebar-day-label">' + safeText(label) + '</span>');
    out.push('    <span class="dpr-sidebar-day-counts" data-total="' + day.papers.length + '"><span class="dpr-sidebar-day-unread">0</span>/<span class="dpr-sidebar-day-total">' + day.papers.length + '</span></span>');
    out.push('  </button>');
    out.push('  <ul class="dpr-sidebar-day-papers">');
    day.papers.forEach(function (p) {
      out.push(renderPaper(p));
    });
    out.push('  </ul>');
    out.push('</li>');
    return out.join('');
  }

  function renderConference(conf) {
    var expanded = state.expandedConfs && state.expandedConfs.has(conf.label);
    var totalPapers = 0;
    conf.topics.forEach(function (t) { totalPapers += t.papers.length; });
    var out = [];
    out.push('<li class="dpr-sidebar-conf' + (expanded ? ' is-expanded' : '') + '" data-conf-label="' + safeAttr(conf.label) + '">');
    out.push('  <button type="button" class="dpr-sidebar-conf-header" aria-expanded="' + (expanded ? 'true' : 'false') + '">');
    out.push('    <span class="dpr-sidebar-day-arrow" aria-hidden="true">▸</span>');
    out.push('    <span class="dpr-sidebar-day-label">' + safeText(conf.label) + '</span>');
    out.push('    <span class="dpr-sidebar-day-counts"><span class="dpr-sidebar-day-unread">0</span>/<span class="dpr-sidebar-day-total">' + totalPapers + '</span></span>');
    out.push('  </button>');
    out.push('  <ul class="dpr-sidebar-conf-topics">');
    conf.topics.forEach(function (topic) {
      out.push('<li class="dpr-sidebar-conf-topic">');
      out.push('  <div class="dpr-sidebar-conf-topic-label">' + safeText(topic.label) + ' <span class="dpr-sidebar-conf-topic-count">' + topic.papers.length + '</span></div>');
      out.push('  <ul class="dpr-sidebar-topic-papers">');
      topic.papers.forEach(function (p) {
        out.push(renderPaper(p));
      });
      out.push('  </ul>');
      out.push('</li>');
    });
    out.push('  </ul>');
    out.push('</li>');
    return out.join('');
  }

  function renderPaper(p) {
    var sectionClass = p.section ? ' dpr-sidebar-paper-' + p.section : '';
    var paperId = p.id || '';
    var searchHaystack = [
      p.title || '',
      p.evidence || '',
      (p.tags || []).map(function (t) { return (t && t.label) || ''; }).join(' '),
    ].join(' ').toLowerCase();
    var dataAttrs = [
      'data-paper-id="' + safeAttr(paperId) + '"',
      'data-href="' + safeAttr(p.href) + '"',
      'data-section="' + safeAttr(p.section || '') + '"',
      'data-search="' + safeAttr(searchHaystack) + '"',
      'data-read="0"',
      'data-read-status=""',
    ].join(' ');
    var stars = starHtmlFromScore(p.score);
    var tagBits = tagsHtml(p.tags);
    var evidence = p.evidence
      ? '<div class="dpr-sidebar-paper-evidence">' + safeText(p.evidence) + '</div>'
      : '';
    return (
      '<li class="dpr-sidebar-paper' + sectionClass + '" ' + dataAttrs + '>' +
      '  <a class="dpr-sidebar-paper-link" href="' + safeAttr(p.href) + '">' +
      '    <span class="dpr-sidebar-paper-title">' + safeText(p.title) + '</span>' +
      '    <span class="dpr-sidebar-paper-meta">' + stars + (tagBits ? '<span class="dpr-sidebar-paper-tags">' + tagBits + '</span>' : '') + '</span>' +
      '  </a>' +
      evidence +
      '</li>'
    );
  }

  // ---------- 状态同步 ----------
  function updateReadStateMarks() {
    if (!state.bodyEl) return;
    var readMap = ReadState.getAll();
    var totalUnread = 0;
    $$('.dpr-sidebar-paper', state.bodyEl).forEach(function (li) {
      var id = li.getAttribute('data-paper-id');
      var status = normalizeReadStatus(id && readMap[id]);
      li.setAttribute('data-read', status ? '1' : '0');
      li.setAttribute('data-read-status', status);
      if (!status) totalUnread += 1;
    });
    // 每个日期/会议节点的 unread 计数
    $$('.dpr-sidebar-day, .dpr-sidebar-conf', state.bodyEl).forEach(function (group) {
      var papers = $$('.dpr-sidebar-paper', group);
      var unread = 0;
      papers.forEach(function (li) {
        if (li.getAttribute('data-read') === '0') unread += 1;
      });
      var totalEl = $('.dpr-sidebar-day-total', group);
      var unreadEl = $('.dpr-sidebar-day-unread', group);
      if (totalEl) totalEl.textContent = String(papers.length);
      if (unreadEl) unreadEl.textContent = String(unread);
      if (unread === 0) {
        group.classList.add('is-all-read');
      } else {
        group.classList.remove('is-all-read');
      }
    });
    if (state.unreadCountEl) {
      state.unreadCountEl.textContent = String(totalUnread);
      state.unreadCountEl.setAttribute('data-count', String(totalUnread));
    }
  }

  function applyFilterAndSearch() {
    if (!state.rootEl) return;
    state.rootEl.classList.toggle('is-filter-unread', state.filter === 'unread');
    var keyword = state.search.trim().toLowerCase();
    state.rootEl.classList.toggle('is-searching', !!keyword);
    if (!state.bodyEl) return;
    if (!keyword) {
      $$('.dpr-sidebar-paper', state.bodyEl).forEach(function (li) {
        li.removeAttribute('data-search-hidden');
      });
      $$('.dpr-sidebar-day, .dpr-sidebar-conf', state.bodyEl).forEach(function (g) {
        g.removeAttribute('data-search-hidden');
      });
      return;
    }
    $$('.dpr-sidebar-paper', state.bodyEl).forEach(function (li) {
      var hay = li.getAttribute('data-search') || '';
      if (hay.indexOf(keyword) === -1) {
        li.setAttribute('data-search-hidden', '1');
      } else {
        li.removeAttribute('data-search-hidden');
      }
    });
    $$('.dpr-sidebar-day, .dpr-sidebar-conf', state.bodyEl).forEach(function (g) {
      var visible = $$('.dpr-sidebar-paper:not([data-search-hidden])', g).length;
      if (visible === 0) g.setAttribute('data-search-hidden', '1');
      else g.removeAttribute('data-search-hidden');
    });
  }

  function syncActive() {
    if (!state.bodyEl) return;
    stripAppNav(state.bodyEl); // docsify 可能再次注入 .app-nav（每次路由）
    var href = findActivePaper();
    $$('.dpr-sidebar-paper.is-active', state.bodyEl).forEach(function (li) {
      li.classList.remove('is-active');
    });
    if (!href) return;
    var li = state.bodyEl.querySelector(
      '.dpr-sidebar-paper[data-href="' + cssEscape(href) + '"]'
    );
    if (!li) return;
    li.classList.add('is-active');
    // 自动展开包含的日期 / 会议
    var dayParent = li.closest('.dpr-sidebar-day');
    if (dayParent && !dayParent.classList.contains('is-expanded')) {
      dayParent.classList.add('is-expanded');
      var btn = $('.dpr-sidebar-day-header', dayParent);
      if (btn) btn.setAttribute('aria-expanded', 'true');
      if (state.expandedDates) state.expandedDates.add(dayParent.getAttribute('data-date'));
      persistCollapse();
    }
    var confParent = li.closest('.dpr-sidebar-conf');
    if (confParent && !confParent.classList.contains('is-expanded')) {
      confParent.classList.add('is-expanded');
      var cbtn = $('.dpr-sidebar-conf-header', confParent);
      if (cbtn) cbtn.setAttribute('aria-expanded', 'true');
      if (state.expandedConfs) state.expandedConfs.add(confParent.getAttribute('data-conf-label'));
      persistCollapse();
    }
    // 居中滚动
    centerOn(li);
  }

  function cssEscape(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/["\\#.]/g, '\\$&');
  }

  function centerOn(li) {
    if (!state.bodyEl || !li) return;
    var bodyRect = state.bodyEl.getBoundingClientRect();
    var liRect = li.getBoundingClientRect();
    var current = state.bodyEl.scrollTop;
    var targetTop = current + (liRect.top - bodyRect.top) - bodyRect.height / 2 + liRect.height / 2;
    state.bodyEl.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
  }

  function dispatchSidebarUpdated() {
    if (!document || typeof document.dispatchEvent !== 'function') return;
    var detail = {
      paperHrefs: collectPaperHrefsFromModel(state.model),
      reportHrefs: collectReportHrefsFromModel(state.model),
      currentPaperHref: findCurrentPaperHrefFromModel(state.model),
      currentReportHref: findCurrentReportHrefFromModel(state.model),
    };
    try {
      document.dispatchEvent(new CustomEvent('dpr-sidebar-updated', { detail: detail }));
    } catch (e) {
      try {
        var event = document.createEvent('CustomEvent');
        event.initCustomEvent('dpr-sidebar-updated', false, false, detail);
        document.dispatchEvent(event);
      } catch (ignored) {}
    }
  }

  function toggleMobile(open) {
    var root = state.rootEl || $('#dpr-sidebar-v2');
    if (!root || !root.classList) return false;
    if (typeof open === 'boolean') {
      root.classList.toggle('is-open', open);
    } else {
      root.classList.toggle('is-open');
    }
    return root.classList.contains('is-open');
  }

  // ---------- 事件 ----------
  function bindEvents(root) {
    // 工具栏：筛选
    root.addEventListener('click', function (e) {
      var fbtn = e.target.closest('.dpr-sidebar-filter-btn');
      if (fbtn) {
        var f = fbtn.getAttribute('data-filter') || 'all';
        state.filter = f === 'unread' ? 'unread' : 'all';
        $$('.dpr-sidebar-filter-btn', root).forEach(function (b) {
          b.classList.toggle('is-active', b.getAttribute('data-filter') === state.filter);
        });
        persistFilter();
        applyFilterAndSearch();
        return;
      }
      // 移动端切换
      var mobile = e.target.closest('.dpr-sidebar-mobile-toggle');
      if (mobile) {
        root.classList.toggle('is-open');
        return;
      }
      // 日期折叠
      var dayHeader = e.target.closest('.dpr-sidebar-day-header');
      if (dayHeader) {
        var li = dayHeader.parentElement;
        var key = li.getAttribute('data-date');
        var open = li.classList.toggle('is-expanded');
        dayHeader.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) state.expandedDates.add(key);
        else state.expandedDates.delete(key);
        persistCollapse();
        return;
      }
      // 会议折叠
      var confHeader = e.target.closest('.dpr-sidebar-conf-header');
      if (confHeader) {
        var li2 = confHeader.parentElement;
        var label = li2.getAttribute('data-conf-label');
        var open2 = li2.classList.toggle('is-expanded');
        confHeader.setAttribute('aria-expanded', open2 ? 'true' : 'false');
        if (open2) state.expandedConfs.add(label);
        else state.expandedConfs.delete(label);
        persistCollapse();
        return;
      }
      // 论文点击：移动端自动关闭抽屉
      var paperLink = e.target.closest('.dpr-sidebar-paper-link');
      if (paperLink) {
        if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) {
          root.classList.remove('is-open');
        }
      }
      // 顶部 Home / Tutorial：移动端自动收起
      var quick = e.target.closest('.dpr-sidebar-quick');
      if (quick) {
        if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) {
          root.classList.remove('is-open');
        }
      }
      // 刷新
      var refresh = e.target.closest('.dpr-sidebar-refresh');
      if (refresh) {
        e.preventDefault();
        refresh.disabled = true;
        loadAndRender().finally(function () { refresh.disabled = false; });
      }
    });

    state.searchInput.addEventListener('input', debounce(function () {
      state.search = state.searchInput.value || '';
      applyFilterAndSearch();
    }, SEARCH_DEBOUNCE_MS));

    window.addEventListener('hashchange', function () { syncActive(); });
    document.addEventListener('dpr-paper-read-state-changed', function () {
      updateReadStateMarks();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (!state.lastFetchAt) return;
      if (Date.now() - state.lastFetchAt < REFRESH_AFTER_HIDDEN_MS) return;
      loadAndRender();
    });
  }

  // ---------- 启动 ----------
  function determineInitialExpansion() {
    // 默认行为：只展开当前激活路由所在的日期；其它折叠
    // 若用户在本地保留过折叠状态则尊重它
    var persisted = loadPersistedCollapse();
    if (persisted) {
      state.expandedDates = persisted.expandedDates || new Set();
      state.expandedConfs = persisted.expandedConfs || new Set();
      return;
    }
    state.expandedDates = new Set();
    state.expandedConfs = new Set();
    var href = findActivePaper();
    if (href) {
      for (var i = 0; i < state.model.daily.length; i++) {
        var day = state.model.daily[i];
        if (day.papers.some(function (p) { return p.href === href; })) {
          state.expandedDates.add(day.dateKey);
          break;
        }
      }
    }
    if (state.expandedDates.size === 0 && state.model.daily.length) {
      state.expandedDates.add(state.model.daily[0].dateKey);
    }
  }

  function loadAndRender() {
    return fetch(SIDEBAR_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('sidebar HTTP ' + r.status);
        return r.text();
      })
      .then(function (text) {
        state.model = parseSidebar(text);
        state.lastFetchAt = Date.now();
        determineInitialExpansion();
        if (!state.rootEl) {
          state.rootEl = ensureRoot();
        }
        renderShell(state.rootEl);
        if (!state._eventsBound) {
          bindEvents(state.rootEl);
          state._eventsBound = true;
        } else {
          // shell 元素被替换了，重新绑搜索框 input 事件
          rebindSearchInput();
        }
        renderBody();
        updateReadStateMarks();
        applyFilterAndSearch();
        syncActive();
        dispatchSidebarUpdated();
      })
      .catch(function (err) {
        console.error('[DPR Sidebar] 加载失败:', err);
        if (state.rootEl && state.bodyEl) {
          state.bodyEl.innerHTML = '<div class="dpr-sidebar-error">侧边栏加载失败</div>';
        }
      });
  }

  function rebindSearchInput() {
    if (!state.searchInput) return;
    state.searchInput.addEventListener('input', debounce(function () {
      state.search = state.searchInput.value || '';
      applyFilterAndSearch();
    }, SEARCH_DEBOUNCE_MS));
  }

  function start() {
    state.filter = loadPersistedFilter();
    state.rootEl = ensureRoot();
    state.rootEl.innerHTML = '<div class="dpr-sidebar-loading">加载中…</div>';
    loadAndRender();
  }

  var DPRSidebarApi = {
    refresh: function () { return loadAndRender(); },
    syncActive: syncActive,
    notifyReadStateChanged: function () { updateReadStateMarks(); },
    getReadState: function () { return ReadState.getAll(); },
    getPaperHrefs: function () { return collectPaperHrefsFromModel(state.model); },
    getReportHrefs: function () { return collectReportHrefsFromModel(state.model); },
    getCurrentHref: function () { return currentRouteHref(); },
    getCurrentPaperHref: function () { return findCurrentPaperHrefFromModel(state.model); },
    getCurrentReportHref: function () { return findCurrentReportHrefFromModel(state.model); },
    openMobile: function () { return toggleMobile(true); },
    closeMobile: function () { return toggleMobile(false); },
    toggleMobile: function () { return toggleMobile(); },
  };

  // 让正文页（评分按钮）和 docsify 插件能消费侧栏状态。
  window.DPRSidebar = DPRSidebarApi;

  if (typeof module === 'object' && module.exports) {
    module.exports = {
      api: DPRSidebarApi,
      __test: {
        parseSidebar: parseSidebar,
        collectPaperHrefsFromModel: collectPaperHrefsFromModel,
        collectReportHrefsFromModel: collectReportHrefsFromModel,
        findCurrentPaperHrefFromModel: findCurrentPaperHrefFromModel,
        findCurrentReportHrefFromModel: findCurrentReportHrefFromModel,
        normalizeReadStatus: normalizeReadStatus,
      },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
