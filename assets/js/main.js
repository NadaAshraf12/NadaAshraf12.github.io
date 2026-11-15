// 0xNADA theme — terminal-chrome code blocks, auto TOC, scroll-spy
(function () {
  // --- 1. Wrap every Rouge code block in a terminal window ---
  var LANG = { bash:'shell', shell:'shell', sh:'shell', console:'shell',
    js:'js', javascript:'js', php:'php', python:'python', py:'python',
    html:'html', xml:'xml', json:'json', yaml:'yaml', sql:'sql', ruby:'ruby' };
  document.querySelectorAll('.highlighter-rouge, div.highlight').forEach(function (block) {
    if (block.closest('.term')) return;
    var lang = '';
    (block.className.match(/language-([\w-]+)/) || []).forEach(function (m, i) { if (i === 1) lang = m; });
    var label = LANG[lang] || lang || 'code';
    var term = document.createElement('div'); term.className = 'term';
    var bar = document.createElement('div'); bar.className = 'term-bar';
    bar.innerHTML = '<span class="d d1"></span><span class="d d2"></span><span class="d d3"></span>' +
                    '<span class="lang">' + label + '</span>';
    block.parentNode.insertBefore(term, block);
    term.appendChild(bar);
    term.appendChild(block);
  });

  // --- 2. Build the table of contents from h2/h3 ---
  var toc = document.getElementById('toc-list');
  var article = document.querySelector('article');
  if (toc && article) {
    var heads = article.querySelectorAll('h2, h3');
    var map = [];
    heads.forEach(function (h) {
      if (!h.id) h.id = h.textContent.trim().toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
      var a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent.replace(/\s+/g, ' ').trim();
      if (h.tagName === 'H3') a.className = 'lvl3';
      toc.appendChild(a);
      map.push({ a: a, el: h });
    });

    // --- 3. Scroll-spy ---
    var obs = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) {
          map.forEach(function (m) { m.a.classList.remove('active'); });
          var hit = map.find(function (m) { return m.el === e.target; });
          if (hit) hit.a.classList.add('active');
        }
      });
    }, { rootMargin: '-15% 0px -75% 0px' });
    map.forEach(function (m) { obs.observe(m.el); });
  }
})();
