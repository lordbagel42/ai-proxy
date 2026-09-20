(() => {
  const $ = (id) => document.getElementById(id);
  const format = new Intl.NumberFormat();
  const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  let mounted = false;
  let days = 7;
  let metric = 'totalTokens';
  let sort = 'totalTokens';
  let direction = -1;
  let showAll = false;
  let data;
  let controller;
  let version = 0;
  let observedChartWidth = 0;
  let chartObserver;
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function svg(tag, attributes, text) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function day(value) { return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
  function date(value) { return new Date(`${value}T00:00:00Z`); }
  function recent(value) {
    if (!value) return '—';
    const elapsed = Math.max(0, Date.now() - value);
    if (elapsed < 60_000) return 'Just now';
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
    return day(value);
  }
  function error(text) { $('analytics-error').textContent = text; $('analytics-error').hidden = !text; }
  function renderChart() {
    if (!data) return;
    const chart = $('analytics-chart');
    const availableWidth = chart.getBoundingClientRect().width;
    if (availableWidth <= 0) return;
    const svgWidth = Math.max(300, Math.min(900, Math.round(availableWidth)));
    chart.setAttribute('viewBox', `0 0 ${svgWidth} 210`);
    chart.replaceChildren();
    const points = data.daily;
    const maximum = Math.max(0, ...points.map((point) => point[metric]));
    const left = 55, top = 15, bottom = 170, width = svgWidth - 75;
    const span = width / Math.max(points.length, 1);
    const tickCount = Math.min(points.length, svgWidth < 560 ? 4 : 7);
    const tickIndices = new Set(Array.from({ length: tickCount }, (_, index) => tickCount === 1 ? 0 : Math.round(index * (points.length - 1) / (tickCount - 1))));
    $('analytics-chart-title').textContent = metric === 'requests' ? 'Request activity' : 'Token usage';
    chart.setAttribute('aria-label', `${metric === 'requests' ? 'Requests' : 'Tokens'} per UTC day over the last ${data.days} days`);
    for (let index = 0; index < 4; index++) {
      const y = bottom - index * (bottom - top) / 3;
      chart.append(svg('line', { x1: left, x2: left + width, y1: y, y2: y, class: 'chart-grid' }));
      if (maximum || !index) chart.append(svg('text', { x: left - 12, y: y + 4, 'text-anchor': 'end', class: 'chart-axis' }, compact.format(maximum * index / 3)));
    }
    points.forEach((point, index) => {
      const barWidth = Math.min(span * .52, 35);
      const x = left + index * span + (span - barWidth) / 2;
      const height = maximum ? point[metric] / maximum * (bottom - top) : 0;
      if (height > 0) {
        const bar = svg('rect', { x, y: bottom - height, width: barWidth, height, rx: 2, class: 'chart-bar', tabindex: '0', 'aria-label': `${day(date(point.date))}: ${format.format(point[metric])} ${metric === 'requests' ? 'requests' : 'tokens'}` });
        bar.append(svg('title', {}, `${day(date(point.date))}: ${format.format(point[metric])} ${metric === 'requests' ? 'requests' : 'tokens'}`)); chart.append(bar);
      }
      if (tickIndices.has(index)) {
        chart.append(svg('text', { x: left + index * span + span / 2, y: bottom + 28, 'text-anchor': 'middle', class: 'chart-axis' }, day(date(point.date))));
      }
    });
    $('analytics-chart-empty').hidden = maximum > 0;
    for (const button of document.querySelectorAll('[data-analytics-metric]')) button.setAttribute('aria-pressed', String(button.dataset.analyticsMetric === metric));
  }
  function renderLeaderboard() {
    if (!data) return;
    const people = [...data.leaderboard].sort((a, b) => {
      const value = sort === 'name' ? a.name.localeCompare(b.name) : (a[sort] || 0) - (b[sort] || 0);
      return value * direction || (sort === 'totalTokens' ? b.requests - a.requests : 0) || a.name.localeCompare(b.name);
    });
    $('analytics-leaderboard-rows').replaceChildren();
    for (const [index, person] of (showAll ? people : people.slice(0, 10)).entries()) {
      const row = node('tr'); const member = node('td'); const details = node('div', 'analytics-person');
      const initials = person.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
      const name = node('span', 'analytics-person-name', person.name);
      details.append(node('span', 'analytics-avatar', initials || '?'), name);
      if (person.isYou) details.append(node('span', 'analytics-you', 'You'));
      member.append(details);
      const last = node('td', 'analytics-last', recent(person.lastActiveAt));
      if (person.lastActiveAt) last.title = new Date(person.lastActiveAt).toLocaleString();
      const tokens = node('td', 'analytics-value', format.format(person.totalTokens));
      tokens.title = `${format.format(person.inputTokens)} input · ${format.format(person.outputTokens)} output`;
      row.append(node('td', 'analytics-rank', String(index + 1)), member, tokens, node('td', 'analytics-value', format.format(person.requests)), node('td', 'analytics-value', format.format(person.toolCalls)), node('td', 'analytics-value', format.format(person.activeDays)), last);
      $('analytics-leaderboard-rows').append(row);
    }
    for (const button of document.querySelectorAll('[data-analytics-sort]')) {
      const selected = button.dataset.analyticsSort === sort;
      const labels = { name: 'Member', totalTokens: 'Tokens', requests: 'Requests', toolCalls: 'Tool calls', activeDays: 'Active days', lastActiveAt: 'Last active' };
      button.textContent = labels[button.dataset.analyticsSort] + (selected ? direction < 0 ? ' ↓' : ' ↑' : '');
      if (selected) button.parentElement.setAttribute('aria-sort', direction < 0 ? 'descending' : 'ascending'); else button.parentElement.removeAttribute('aria-sort');
    }
    const labels = { name: 'name', totalTokens: 'tokens used', requests: 'requests', toolCalls: 'tool calls issued', activeDays: 'active days', lastActiveAt: 'last activity' };
    $('analytics-ranking').textContent = `Sorted by ${labels[sort]} · ${direction < 0 ? 'descending' : 'ascending'}`;
    $('analytics-member-count').textContent = people.length === 50 ? 'Top 50 by tokens' : `${format.format(people.length)} member${people.length === 1 ? '' : 's'}`;
    $('analytics-leaderboard-empty').hidden = people.length > 0;
    $('analytics-show-all').hidden = people.length <= 10;
    $('analytics-show-all').textContent = showAll ? 'Show top 10' : `Show all ${format.format(people.length)} members`;
  }
  function render() {
    const totals = data.totals;
    const settled = totals.successfulRequests + totals.failedRequests + totals.cancelledRequests;
    $('analytics-requests').textContent = format.format(totals.requests);
    const requestDetails = [`${format.format(totals.successfulRequests)} completed`, `${format.format(totals.failedRequests)} failed`];
    if (totals.cancelledRequests) requestDetails.push(`${format.format(totals.cancelledRequests)} cancelled`);
    if (totals.runningRequests) requestDetails.push(`${format.format(totals.runningRequests)} in flight`);
    $('analytics-requests-detail').textContent = requestDetails.join(' · ');
    $('analytics-tokens').textContent = compact.format(totals.totalTokens); $('analytics-tokens').title = format.format(totals.totalTokens);
    $('analytics-token-detail').textContent = `${compact.format(totals.inputTokens)} input · ${compact.format(totals.outputTokens)} output · ${compact.format(totals.cachedTokens)} cached input`;
    $('analytics-token-detail').title = `${format.format(totals.cachedTokens)} cached tokens are a subset of the ${format.format(totals.inputTokens)} input tokens.`;
    $('analytics-tools').textContent = format.format(totals.toolCalls);
    $('analytics-success').textContent = settled ? `${totals.successRate.toFixed(1)}%` : '—';
    $('analytics-duration').textContent = settled ? `${(totals.avgDurationMs / 1000).toFixed(1)}s avg. full response` : 'No finished requests';
    $('analytics-period').textContent = `${day(data.from)} – ${day(data.to)} · ${data.days} days`;
    $('analytics-active').textContent = `${format.format(totals.activeMembers)} active member${totals.activeMembers === 1 ? '' : 's'}`;
    renderChart(); renderLeaderboard();
    $('analytics-model-rows').replaceChildren();
    for (const model of data.models) {
      const row = node('tr'); const name = node('td'); name.append(node('code', '', model.model));
      row.append(name, node('td', 'analytics-value', format.format(model.requests)), node('td', 'analytics-value', format.format(model.totalTokens)), node('td', 'analytics-value', format.format(model.toolCalls))); $('analytics-model-rows').append(row);
    }
    $('analytics-model-empty').hidden = data.models.length > 0;
  }
  async function load() {
    const current = ++version; controller?.abort(); controller = new AbortController();
    $('analytics-content').setAttribute('aria-busy', 'true'); $('analytics-refresh').disabled = true; error('');
    for (const button of document.querySelectorAll('[data-analytics-days]')) button.setAttribute('aria-pressed', String(Number(button.dataset.analyticsDays) === days));
    try {
      const response = await fetch(`/api/analytics?days=${days}`, { credentials: 'same-origin', signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error?.message || 'Analytics could not be loaded. Try refreshing.');
      if (current !== version) return; data = result; render();
    } catch (failure) { if (current === version && failure.name !== 'AbortError') error(failure.message); }
    finally { if (current === version) { $('analytics-content').setAttribute('aria-busy', 'false'); $('analytics-refresh').disabled = false; } }
  }
  window.FriendsAnalytics = { mount() {
    if (mounted || !$('analytics-shell')) return; mounted = true;
    for (const button of document.querySelectorAll('[data-analytics-days]')) button.addEventListener('click', () => { days = Number(button.dataset.analyticsDays); showAll = false; void load(); });
    for (const button of document.querySelectorAll('[data-analytics-metric]')) button.addEventListener('click', () => { metric = button.dataset.analyticsMetric; renderChart(); });
    for (const button of document.querySelectorAll('[data-analytics-sort]')) button.addEventListener('click', () => {
      if (sort === button.dataset.analyticsSort) direction *= -1; else { sort = button.dataset.analyticsSort; direction = sort === 'name' ? 1 : -1; }
      renderLeaderboard();
    });
    $('analytics-show-all').addEventListener('click', () => { showAll = !showAll; renderLeaderboard(); });
    $('analytics-refresh').addEventListener('click', () => void load());
    chartObserver = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width || 0);
      if (width <= 0) { observedChartWidth = 0; return; }
      if (width === observedChartWidth) return;
      observedChartWidth = width; renderChart();
    });
    chartObserver.observe($('analytics-chart').parentElement);
    window.addEventListener('pagehide', () => controller?.abort());
    void load();
  } };
})();
