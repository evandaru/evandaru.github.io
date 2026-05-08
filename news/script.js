// ===== STATE =====
      let allArticles = [];
      let filteredArticles = [];
      let feedStatuses = {};
      let currentFilter = "all";
      let currentFeedFilter = "all";
      let currentView = "grid";
      let sortAsc = false;
      let readArticles = new Set();
      let focusedIndex = -1;
      let readerArticleIndex = -1;
      let readerFontSize = 16;
      let readerFetching = false;

      // ===== INIT =====
      document.addEventListener("DOMContentLoaded", () => {
        loadReadState();
        buildSidebar();
        fetchAllFeeds();
      });

      // ===== LOAD/SAVE READ STATE =====
      function loadReadState() {
        try {
          const saved = localStorage.getItem("brutal_rss_read");
          if (saved) readArticles = new Set(JSON.parse(saved));
          const savedFont = localStorage.getItem("brutal_rss_fontsize");
          if (savedFont) readerFontSize = parseInt(savedFont);
        } catch (e) {}
      }

      function saveReadState() {
        try {
          const arr = Array.from(readArticles).slice(-2000);
          localStorage.setItem("brutal_rss_read", JSON.stringify(arr));
        } catch (e) {}
      }

      // ===== BUILD SIDEBAR =====
      function buildSidebar() {
        const list = document.getElementById("feedList");
        list.innerHTML = "";

        const allItem = document.createElement("li");
        allItem.className = "feed-item active";
        allItem.id = "feed-all";
        allItem.innerHTML = `<div class="feed-item-name"><span class="feed-dot" style="background:var(--fg)"></span> ALL FEEDS<span class="feed-item-count" id="count-all">0</span></div>`;
        allItem.onclick = () => selectFeed("all");
        list.appendChild(allItem);

        FEEDS.forEach((feed, i) => {
          const li = document.createElement("li");
          li.className = "feed-item";
          li.id = `feed-${i}`;
          li.innerHTML = `<div class="feed-item-name"><span class="feed-dot" style="background:${feed.color}"></span>${feed.name}<span class="feed-item-count" id="count-${i}">0</span></div>`;
          li.onclick = () => selectFeed(i);
          list.appendChild(li);
        });

        document.getElementById("feedCount").textContent = FEEDS.length;
      }

      // ===== FETCH FEEDS =====
      async function fetchAllFeeds() {
        const btn = document.getElementById("refreshBtn");
        btn.classList.add("loading");
        btn.textContent = "⟳ FETCHING...";

        allArticles = [];
        feedStatuses = {};

        let completed = 0;
        const total = FEEDS.length;

        updateLoading(completed, total);

        const promises = FEEDS.map((feed, i) =>
          fetchSingleFeed(feed, i, () => {
            completed++;
            updateLoading(completed, total);
          }),
        );

        await Promise.allSettled(promises);

        applyFilters();
        updateCounts();
        updateStats();

        btn.classList.remove("loading");
        btn.textContent = "⟳ REFRESH";

        if (allArticles.length === 0) {
          showEmptyState();
        } else {
          showToast(
            `Loaded ${allArticles.length} articles from ${completed} feeds`,
            "success",
          );
        }
      }

      async function fetchSingleFeed(feed, index, onProgress) {
        const feedEl = document.getElementById(`feed-${index}`);
        if (feedEl) feedEl.classList.add("loading");

        for (const proxyFn of PROXIES) {
          try {
            const proxyUrl = proxyFn(feed.url);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);

            const resp = await fetch(proxyUrl, { signal: controller.signal });
            clearTimeout(timeout);

            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

            const resText = await resp.text();
            let dataItems = [];

            if (proxyUrl.includes("allorigins.win") || proxyUrl.includes("cors.eu.org")) {
              let xmlContent = resText;
              if (proxyUrl.includes("allorigins.win")) {
                try {
                  const resData = JSON.parse(resText);
                  xmlContent = resData.contents || "";
                } catch (e) {
                  throw new Error("Failed to parse allorigins JSON");
                }
              }

              if (xmlContent) {
                const parser = new DOMParser();
                const xmlDoc = parser.parseFromString(xmlContent, "text/xml");
                const items = xmlDoc.querySelectorAll("item, entry");
                items.forEach(item => {
                  const getTag = (name) => item.getElementsByTagName(name)[0]?.textContent || "";
                  const getTagWithNS = (ns, name) => item.getElementsByTagNameNS(ns, name)[0]?.textContent || "";
                  
                  let link = getTag("link");
                  if (!link) {
                    const linkNode = item.getElementsByTagName("link")[0];
                    if (linkNode) link = linkNode.getAttribute("href") || "";
                  }

                  let thumb = "";
                  const mediaContent = item.getElementsByTagNameNS("http://search.yahoo.com/mrss/", "content")[0] || item.getElementsByTagName("media:content")[0];
                  if (mediaContent) thumb = mediaContent.getAttribute("url") || "";
                  if (!thumb) {
                    const enclosure = item.getElementsByTagName("enclosure")[0];
                    if (enclosure && enclosure.getAttribute("type")?.startsWith("image")) {
                      thumb = enclosure.getAttribute("url") || "";
                    }
                  }

                  dataItems.push({
                    title: getTag("title"),
                    link: link,
                    description: getTag("description") || getTag("summary"),
                    content: getTagWithNS("*", "encoded") || getTag("content"),
                    pubDate: getTag("pubDate") || getTag("published") || getTag("updated"),
                    guid: getTag("guid") || getTag("id"),
                    author: getTag("dc:creator") || getTag("author") || "",
                    thumbnail: thumb
                  });
                });
              }
            } else {
              const resData = JSON.parse(resText);
              if (resData.status === "ok" && resData.items) {
                dataItems = resData.items;
              } else {
                throw new Error("RSS2JSON Error: " + resData.message);
              }
            }

            if (dataItems.length > 0) {
              const threeDaysAgo = new Date();
              threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

              // Ambil artikel yang usianya maksimal 3 hari, lalu batasi 10 artikel per feed
              const articles = dataItems
                .map((item) => {
                  const fullContent =
                    item.content ||
                    item["content:encoded"] ||
                    item.description ||
                    "";
                  return {
                    id:
                      item.guid ||
                      item.link ||
                      btoa(item.title + item.pubDate).substring(0, 20),
                    title: stripHtml(item.title || "Untitled"),
                    link: item.link || "#",
                    snippet: stripHtml(item.description || "").substring(0, 300),
                    fullContent: fullContent,
                    pubDate: item.pubDate ? new Date(item.pubDate) : new Date(),
                    feedIndex: index,
                    feedName: feed.name,
                    feedColor: feed.color,
                    image:
                      item.thumbnail ||
                      item.enclosure?.link ||
                      extractImage(fullContent),
                    author: item.author || "",
                  };
                })
                .filter((article) => article.pubDate >= threeDaysAgo)
                .slice(0, 10);

              allArticles.push(...articles);
              feedStatuses[index] = { ok: true, count: articles.length };

              if (feedEl) {
                feedEl.classList.remove("loading", "error");
                const countEl = document.getElementById(`count-${index}`);
                if (countEl) countEl.textContent = articles.length;
              }
              onProgress();
              return;
            }
          } catch (e) {
            console.error("Proxy failed:", proxyFn(feed.url), e);
          }
        }

        feedStatuses[index] = { ok: false, count: 0 };
        if (feedEl) {
          feedEl.classList.remove("loading");
          feedEl.classList.add("error");
        }
        onProgress();
      }

      const PROXIES = [
        (url) => `https://cors.eu.org/${url}`,
        (url) =>
          `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`,
        (url) =>
          `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
      ];

      function updateLoading(completed, total) {
        const pct = (completed / total) * 100;
        document.getElementById("loadingBarFill").style.width = pct + "%";
        document.getElementById("loadingProgress").textContent =
          `${completed} / ${total} feeds`;
      }

      function stripHtml(html) {
        if (!html) return "";
        const tmp = document.createElement("div");
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || "";
      }

      function extractImage(html) {
        if (!html) return "";
        const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
        return match ? match[1] : "";
      }

      // ===== FILTERS & SORTING =====
      function applyFilters() {
        filteredArticles = [...allArticles];

        if (currentFeedFilter !== "all") {
          filteredArticles = filteredArticles.filter(
            (a) => a.feedIndex === currentFeedFilter,
          );
        }

        if (currentFilter === "unread") {
          filteredArticles = filteredArticles.filter(
            (a) => !readArticles.has(a.id),
          );
        }

        const query = document
          .getElementById("searchInput")
          .value.toLowerCase()
          .trim();
        if (query) {
          filteredArticles = filteredArticles.filter(
            (a) =>
              a.title.toLowerCase().includes(query) ||
              a.snippet.toLowerCase().includes(query) ||
              a.feedName.toLowerCase().includes(query),
          );
        }

        filteredArticles.sort((a, b) => {
          return sortAsc ? a.pubDate - b.pubDate : b.pubDate - a.pubDate;
        });

        focusedIndex = -1;
        renderArticles();
      }

      function setFilter(filter) {
        currentFilter = filter;
        document.querySelectorAll(".filter-btn").forEach((btn) => {
          btn.classList.toggle("active", btn.dataset.filter === filter);
        });
        applyFilters();
      }

      function selectFeed(index) {
        currentFeedFilter = index;
        document
          .querySelectorAll(".feed-item")
          .forEach((el) => el.classList.remove("active"));
        const el = document.getElementById(
          index === "all" ? "feed-all" : `feed-${index}`,
        );
        if (el) el.classList.add("active");

        const name = index === "all" ? "ALL FEEDS" : FEEDS[index].name;
        document.getElementById("contentTitle").textContent = name;

        applyFilters();
        closeSidebar();
      }

      function handleSearch() {
        applyFilters();
      }

      function toggleSort() {
        sortAsc = !sortAsc;
        document.getElementById("sortBtn").textContent = sortAsc
          ? "↑ OLDEST"
          : "↓ NEWEST";
        applyFilters();
      }

      function setView(view) {
        currentView = view;
        document
          .getElementById("gridViewBtn")
          .classList.toggle("active", view === "grid");
        document
          .getElementById("listViewBtn")
          .classList.toggle("active", view === "list");
        const container = document.getElementById("articlesContainer");
        const grid = container.querySelector(".articles-grid");
        if (grid) {
          grid.classList.toggle("list-view", view === "list");
        }
      }

      // ===== RENDER ARTICLES =====
      function renderArticles() {
        const container = document.getElementById("articlesContainer");

        if (filteredArticles.length === 0) {
          container.innerHTML = `
      <div class="empty-state">
        <span class="big-icon">⊘</span>
        <h3>NO ARTICLES FOUND</h3>
        <p>Try adjusting your filters or refresh the feeds.</p>
      </div>
    `;
          return;
        }

        const listViewClass = currentView === "list" ? "list-view" : "";

        let html = `<div class="articles-grid ${listViewClass}" id="articlesGrid">`;

        filteredArticles.forEach((article, i) => {
          const isRead = readArticles.has(article.id);
          const dateStr = formatDate(article.pubDate);
          const imgHtml = article.image
            ? `<img class="article-image" src="${escapeAttr(article.image)}" alt="" loading="lazy" onerror="this.style.display='none'">`
            : "";

          html += `
      <article class="article-card ${isRead ? "read" : ""}" data-index="${i}" data-id="${escapeAttr(article.id)}">
        <div class="article-source-bar" style="background:${article.feedColor};color:#fff;">
          <span class="source-tag"><span class="source-dot" style="background:#fff"></span>${article.feedName}</span>
          <span class="article-date">${dateStr}</span>
        </div>
        ${imgHtml}
        <div class="article-body">
          <div class="article-title" onclick="openArticle(${i})">${escapeHtml(article.title)}</div>
          <div class="article-snippet">${escapeHtml(article.snippet)}</div>
        </div>
        <div class="article-actions">
          <button class="article-action-btn" onclick="openArticle(${i})">📖 READ</button>
          <button class="article-action-btn" onclick="toggleRead(${i})">${isRead ? "UNREAD" : "MARK READ"}</button>
          <button class="article-action-btn" onclick="openExternalLink(${i})">EXT ↗</button>
        </div>
      </article>
    `;
        });

        html += "</div>";
        container.innerHTML = html;
      }

      function formatDate(date) {
        if (!date) return "";
        const now = new Date();
        const diff = now - date;
        const mins = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (mins < 1) return "NOW";
        if (mins < 60) return `${mins}m ago`;
        if (hours < 24) return `${hours}h ago`;
        if (days < 7) return `${days}d ago`;
        return date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
      }

      function escapeHtml(str) {
        if (!str) return "";
        return str
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }

      function escapeAttr(str) {
        if (!str) return "";
        return str
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      }

      // ===== ARTICLE ACTIONS =====
      function openArticle(index) {
        const article = filteredArticles[index];
        if (!article) return;
        readArticles.add(article.id);
        saveReadState();
        updateStats();
        renderArticles();
        openReader(index);
      }

      function openExternalLink(index) {
        const article = filteredArticles[index];
        if (!article) return;
        readArticles.add(article.id);
        saveReadState();
        updateStats();
        renderArticles();
        window.open(article.link, "_blank");
      }

      function toggleRead(index) {
        const article = filteredArticles[index];
        if (!article) return;
        if (readArticles.has(article.id)) {
          readArticles.delete(article.id);
        } else {
          readArticles.add(article.id);
        }
        saveReadState();
        updateStats();
        renderArticles();
      }

      function markAllRead() {
        filteredArticles.forEach((a) => readArticles.add(a.id));
        saveReadState();
        updateStats();
        renderArticles();
        showToast("All articles marked as read", "success");
      }

      // ===== UPDATE COUNTS =====
      function updateCounts() {
        document.getElementById("count-all").textContent = allArticles.length;
        for (let i = 0; i < FEEDS.length; i++) {
          const count = feedStatuses[i]?.count || 0;
          const el = document.getElementById(`count-${i}`);
          if (el) el.textContent = count;
        }
        document.getElementById("articleCount").textContent =
          allArticles.length;
      }

      function updateStats() {
        const unread = allArticles.filter(
          (a) => !readArticles.has(a.id),
        ).length;
        document.getElementById("unreadCount").textContent = unread;
      }

      function showEmptyState() {
        document.getElementById("articlesContainer").innerHTML = `
    <div class="empty-state">
      <span class="big-icon">✕</span>
      <h3>NO ARTICLES LOADED</h3>
      <p>Some feeds may have failed. Try refreshing.</p>
    </div>
  `;
      }

      function refreshFeeds() {
        fetchAllFeeds();
      }

      // ===== SIDEBAR TOGGLE =====
      function toggleSidebar() {
        document.getElementById("sidebar").classList.toggle("open");
        document.getElementById("sidebarBackdrop").classList.toggle("open");
      }

      function closeSidebar() {
        document.getElementById("sidebar").classList.remove("open");
        document.getElementById("sidebarBackdrop").classList.remove("open");
      }

      // ===== TOAST =====
      function showToast(message, type = "") {
        const container = document.getElementById("toastContainer");
        const toast = document.createElement("div");
        toast.className = `toast ${type}`;
        toast.textContent = `>> ${message}`;
        container.appendChild(toast);
        setTimeout(() => {
          toast.style.opacity = "0";
          toast.style.transition = "opacity 0.3s";
          setTimeout(() => toast.remove(), 300);
        }, 3000);
      }

      // ===== ARTICLE READER =====
      function openReader(index) {
        readerArticleIndex = index;
        const article = filteredArticles[index];
        if (!article) return;

        document.body.classList.add("reader-open");
        document.getElementById("readerOverlay").classList.add("open");

        document.getElementById("readerSourceTag").textContent =
          article.feedName;
        document.getElementById("readerSourceTag").style.color =
          article.feedColor;

        updateReaderNavButtons();
        renderReader(article);
      }

      function closeReader() {
        document.body.classList.remove("reader-open");
        document.getElementById("readerOverlay").classList.remove("open");
        readerFetching = false;
      }

      function renderReader(article) {
        const wrapper = document.getElementById("readerContentWrapper");
        const dateStr = article.pubDate.toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        });

        // Check if we have rich content
        const hasRichContent =
          article.fullContent && stripHtml(article.fullContent).length > 200;

        let contentHtml = "";

        if (hasRichContent) {
          // Use the full content from RSS
          let processedContent = processContent(article.fullContent);
          const wordCount = stripHtml(processedContent)
            .split(/\s+/)
            .filter(Boolean).length;
          const readTime = Math.max(1, Math.ceil(wordCount / 200));

          contentHtml = `
      <div class="reader-article-header">
        <div class="reader-article-meta">
          <span class="reader-feed-badge" style="background:${article.feedColor}">${article.feedName}</span>
          <span class="reader-date">${dateStr}</span>
          ${article.author ? `<span class="reader-date">BY ${article.author.toUpperCase()}</span>` : ""}
          <span class="reader-date">${wordCount} WORDS · ${readTime} MIN READ</span>
        </div>
        <h1 class="reader-article-title">${escapeHtml(article.title)}</h1>
        <a href="${escapeAttr(article.link)}" target="_blank" class="reader-article-link">ORIGINAL SOURCE ↗</a>
      </div>
      <div class="reader-article-content" id="readerArticleBody" style="font-size:${readerFontSize}px">
        ${processedContent}
      </div>
      <div class="reader-word-count">${wordCount} WORDS · ${readTime} MIN READ · ${dateStr}</div>
    `;
        } else {
          // Need to fetch the full article
          const wordCount = stripHtml(article.snippet)
            .split(/\s+/)
            .filter(Boolean).length;
          contentHtml = `
      <div class="reader-article-header">
        <div class="reader-article-meta">
          <span class="reader-feed-badge" style="background:${article.feedColor}">${article.feedName}</span>
          <span class="reader-date">${dateStr}</span>
        </div>
        <h1 class="reader-article-title">${escapeHtml(article.title)}</h1>
        <a href="${escapeAttr(article.link)}" target="_blank" class="reader-article-link">ORIGINAL SOURCE ↗</a>
      </div>
      <div id="readerArticleBody" style="font-size:${readerFontSize}px">
        <div class="reader-error" id="readerErrorArea">
          <div class="big-icon" style="font-size:3rem;margin-bottom:16px;display:block;">⊘</div>
          <h3>ARTICLE CONTENT NOT AVAILABLE</h3>
          <p>The RSS feed only provided a short snippet. Click below to attempt fetching the full article content.</p>
          <button class="reader-fetch-btn" id="fetchArticleBtn" onclick="fetchFullArticle()">⚡ FETCH FULL ARTICLE</button>
        </div>
        <div class="reader-article-content" id="readerArticleText" style="display:none;"></div>
        <div class="reader-word-count" id="readerWordCount" style="display:none;"></div>
      </div>
    `;
        }

        wrapper.innerHTML = contentHtml;

        // Scroll to top
        document.getElementById("readerBody").scrollTop = 0;

        // Update progress bar
        updateReaderProgress();
      }

      function processContent(html) {
        if (!html) return "<p>No content available.</p>";

        // Fix relative URLs for common patterns
        const article = filteredArticles[readerArticleIndex];
        if (article) {
          try {
            const urlObj = new URL(article.link);
            const origin = urlObj.origin;

            // Fix relative image URLs
            html = html.replace(
              /src=["']\/([^"']+)["']/g,
              `src="${origin}/$1"`,
            );
            html = html.replace(
              /href=["']\/([^"']+)["']/g,
              `href="${origin}/$1"`,
            );
          } catch (e) {}
        }

        return html;
      }

      async function fetchFullArticle() {
        if (readerFetching) return;
        readerFetching = true;

        const article = filteredArticles[readerArticleIndex];
        if (!article) return;

        const btn = document.getElementById("fetchArticleBtn");
        if (btn) {
          btn.textContent = "⏳ FETCHING...";
          btn.style.opacity = "0.6";
          btn.style.pointerEvents = "none";
        }

        // Try fetching via allorigins
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 20000);

          const resp = await fetch(
            `https://api.allorigins.win/get?url=${encodeURIComponent(article.link)}`,
            {
              signal: controller.signal,
            },
          );
          clearTimeout(timeout);

          if (!resp.ok) throw new Error("Failed to fetch");

          const data = await resp.json();

          if (data.contents) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(data.contents, "text/html");

            // Try to extract article content using common selectors
            let articleContent = null;
            const selectors = [
              "article",
              ".post-content",
              ".entry-content",
              ".article-content",
              ".article-body",
              ".content-body",
              ".story-body",
              ".post-body",
              "#article-body",
              ".main-content",
              ".article__body",
              ".content",
              ".article",
              "main",
              ".content-main",
            ];

            for (const sel of selectors) {
              const el = doc.querySelector(sel);
              if (el && el.textContent.trim().length > 200) {
                articleContent = el;
                break;
              }
            }

            // If no article element found, try to find the longest content block
            if (!articleContent) {
              const paragraphs = doc.querySelectorAll("p");
              if (paragraphs.length > 3) {
                // Find parent container with most paragraphs
                const parentMap = new Map();
                paragraphs.forEach((p) => {
                  const parent = p.parentElement;
                  if (parent && parent.tagName !== "BODY") {
                    const count = parentMap.get(parent) || 0;
                    parentMap.set(parent, count + 1);
                  }
                });

                let bestParent = null;
                let bestCount = 0;
                parentMap.forEach((count, parent) => {
                  if (
                    count > bestCount &&
                    parent.textContent.trim().length > 300
                  ) {
                    bestCount = count;
                    bestParent = parent;
                  }
                });

                if (bestParent) {
                  articleContent = bestParent;
                }
              }
            }

            if (articleContent) {
              // Fix URLs
              const baseUrl = article.link;
              articleContent.querySelectorAll("a[href]").forEach((a) => {
                try {
                  const href = a.getAttribute("href");
                  if (href && !href.startsWith("http")) {
                    a.href = new URL(href, baseUrl).href;
                  }
                } catch (e) {}
              });

              articleContent.querySelectorAll("img[src]").forEach((img) => {
                try {
                  const src = img.getAttribute("src");
                  if (
                    src &&
                    !src.startsWith("http") &&
                    !src.startsWith("data:")
                  ) {
                    img.src = new URL(src, baseUrl).href;
                  }
                } catch (e) {}
              });

              const contentHtml = processContent(articleContent.innerHTML);
              const wordCount = stripHtml(contentHtml)
                .split(/\s+/)
                .filter(Boolean).length;
              const readTime = Math.max(1, Math.ceil(wordCount / 200));

              const textDiv = document.getElementById("readerArticleText");
              const errorDiv = document.getElementById("readerErrorArea");
              const wordCountDiv = document.getElementById("readerWordCount");

              if (textDiv) {
                textDiv.innerHTML = contentHtml;
                textDiv.style.display = "block";
              }
              if (errorDiv) errorDiv.style.display = "none";
              if (wordCountDiv) {
                wordCountDiv.style.display = "block";
                wordCountDiv.textContent = `${wordCount} WORDS · ${readTime} MIN READ · FETCHED`;
              }

              showToast("Article fetched successfully", "success");
            } else {
              throw new Error("No article content found");
            }
          } else {
            throw new Error("No content returned");
          }
        } catch (e) {
          const btn = document.getElementById("fetchArticleBtn");
          if (btn) {
            btn.textContent = "✕ FETCH FAILED — TRY EXTERNAL";
            btn.style.background = "var(--fg)";
            btn.style.color = "var(--bg)";
            btn.style.borderColor = "var(--accent)";
            btn.onclick = () => {
              window.open(article.link, "_blank");
            };
          }
          showToast("Failed to fetch full article content", "error");
        }

        readerFetching = false;
        updateReaderProgress();
      }

      function readerNavigate(dir) {
        const newIndex = readerArticleIndex + dir;
        if (newIndex < 0 || newIndex >= filteredArticles.length) return;
        readerFetching = false;
        openReader(newIndex);
      }

      function updateReaderNavButtons() {
        document.getElementById("readerPrevBtn").disabled =
          readerArticleIndex <= 0;
        document.getElementById("readerNextBtn").disabled =
          readerArticleIndex >= filteredArticles.length - 1;
      }

      function openExternal() {
        const article = filteredArticles[readerArticleIndex];
        if (article) window.open(article.link, "_blank");
      }

      function changeFontSize(dir) {
        readerFontSize = Math.max(12, Math.min(28, readerFontSize + dir * 2));
        const body = document.getElementById("readerArticleBody");
        if (body) body.style.fontSize = readerFontSize + "px";
        document.getElementById("readerFontLabel").textContent =
          readerFontSize + "px";
        localStorage.setItem("brutal_rss_fontsize", readerFontSize);
      }

      function updateReaderProgress() {
        const body = document.getElementById("readerBody");
        const fill = document.getElementById("readerProgressFill");
        if (!body || !fill) return;

        const scrollTop = body.scrollTop;
        const scrollHeight = body.scrollHeight - body.clientHeight;
        const pct = scrollHeight > 0 ? (scrollTop / scrollHeight) * 100 : 0;
        fill.style.width = Math.min(100, pct) + "%";
      }

      document
        .getElementById("readerBody")
        .addEventListener("scroll", updateReaderProgress);

      // ===== KEYBOARD SHORTCUTS =====
      document.addEventListener("keydown", (e) => {
        // Don't capture when typing in input
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
          if (e.key === "Escape") e.target.blur();
          return;
        }

        const readerOpen = document
          .getElementById("readerOverlay")
          .classList.contains("open");

        if (readerOpen) {
          switch (e.key) {
            case "Escape":
              closeReader();
              break;
            case "ArrowRight":
              e.preventDefault();
              readerNavigate(1);
              break;
            case "ArrowLeft":
              e.preventDefault();
              readerNavigate(-1);
              break;
            case "+":
            case "=":
              e.preventDefault();
              changeFontSize(1);
              break;
            case "-":
            case "_":
              e.preventDefault();
              changeFontSize(-1);
              break;
            case "j":
            case "J":
              readerNavigate(1);
              break;
            case "k":
            case "K":
              readerNavigate(-1);
              break;
            case "o":
            case "O":
              openExternal();
              break;
          }
          return;
        }

        switch (e.key) {
          case "/":
            e.preventDefault();
            document.getElementById("searchInput").focus();
            break;
          case "r":
          case "R":
            refreshFeeds();
            break;
          case "s":
          case "S":
            toggleSidebar();
            break;
          case "g":
          case "G":
            setView("grid");
            break;
          case "l":
          case "L":
            setView("list");
            break;
          case "m":
          case "M":
            markAllRead();
            break;
          case "?":
            openShortcuts();
            break;
          case "j":
          case "ArrowDown":
            e.preventDefault();
            navigateArticle(1);
            break;
          case "k":
          case "ArrowUp":
            e.preventDefault();
            navigateArticle(-1);
            break;
          case "Enter":
            if (focusedIndex >= 0) openArticle(focusedIndex);
            break;
          case "Escape":
            closeShortcuts();
            break;
        }
      });

      function navigateArticle(dir) {
        if (filteredArticles.length === 0) return;
        focusedIndex = Math.max(
          0,
          Math.min(filteredArticles.length - 1, focusedIndex + dir),
        );
        document
          .querySelectorAll(".article-card")
          .forEach((c) => c.classList.remove("focused"));
        const card = document.querySelector(
          `.article-card[data-index="${focusedIndex}"]`,
        );
        if (card) {
          card.classList.add("focused");
          card.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      }

      function openShortcuts() {
        document.getElementById("shortcutsModal").classList.add("open");
      }

      function closeShortcuts() {
        document.getElementById("shortcutsModal").classList.remove("open");
      }

      document
        .getElementById("shortcutsModal")
        .addEventListener("click", (e) => {
          if (e.target === document.getElementById("shortcutsModal"))
            closeShortcuts();
        });
