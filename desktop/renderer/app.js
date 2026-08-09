(() => {
  const api = window.storyClaw;
  const root = document.getElementById("storyclaw-gui-concept");
  if (!api || !root) return;

  const state = {
    projects: [],
    selectedProject: null,
    pendingInput: null,
    renderMode: "images_only",
    running: null,
    previewItems: [],
    previewIndex: -1,
    selectedEpisode: 1,
    previewLoadId: 0,
    showingFinalFilm: false,
    lastLog: "就绪",
  };

  const style = document.createElement("style");
  style.textContent = `
    html, body { width: 100%; height: 100%; min-width: 0; min-height: 0; margin: 0; overflow: hidden !important; background: #090a0c; }
    #storyclaw-gui-concept { width: 100%; height: 100vh; min-height: 0; overflow: hidden !important; border: 0 !important; border-radius: 0 !important; }
    #storyclaw-gui-concept .sc-shell { display: none !important; }
    #storyclaw-gui-concept .claw-app,
    #storyclaw-gui-concept .claw-library { width: 100%; height: 100%; min-height: 0; overflow: hidden; }
    #storyclaw-gui-concept .claw-library-view { width: 100%; height: 100%; min-height: 0; overflow: hidden; }
    #storyclaw-gui-concept .claw-library-view:not(.claw-home-view) { overflow-x: hidden; overflow-y: auto; scrollbar-gutter: stable; }
    #storyclaw-gui-concept .claw-library-view::-webkit-scrollbar { width: 10px; }
    #storyclaw-gui-concept .claw-library-view::-webkit-scrollbar-track { background: #111213; }
    #storyclaw-gui-concept .claw-library-view::-webkit-scrollbar-thumb { border: 2px solid #111213; border-radius: 999px; background: #4a4c50; }
    #storyclaw-gui-concept .claw-library-view::-webkit-scrollbar-thumb:hover { background: #6a6d72; }
    #storyclaw-gui-concept .claw-editor { width: 100%; height: 100%; min-height: 0; overflow-x: hidden; overflow-y: auto; }
    #storyclaw-gui-concept .desktop-runbar { position: fixed; right: 24px; bottom: 22px; z-index: 100; display: grid; grid-template-columns: minmax(210px, 1fr) auto auto auto auto; align-items: center; gap: 10px; width: min(820px, calc(100vw - 48px)); padding: 11px 13px; border: 1px solid var(--claw-line-strong); border-radius: 11px; background: rgba(20, 21, 23, .96); box-shadow: 0 14px 40px rgba(0, 0, 0, .38); backdrop-filter: blur(12px); }
    #storyclaw-gui-concept .desktop-run-copy { min-width: 0; display: grid; gap: 4px; }
    #storyclaw-gui-concept .desktop-run-title { overflow: hidden; color: var(--claw-text); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
    #storyclaw-gui-concept .desktop-run-status { overflow: hidden; color: var(--claw-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    #storyclaw-gui-concept .desktop-runbar select,
    #storyclaw-gui-concept .desktop-runbar button { height: 34px; border: 1px solid var(--claw-line); border-radius: 7px; background: var(--claw-panel); color: var(--claw-text); }
    #storyclaw-gui-concept .desktop-runbar select { padding: 0 8px; }
    #storyclaw-gui-concept .desktop-runbar button { display: inline-flex; align-items: center; gap: 6px; padding: 0 11px; }
    #storyclaw-gui-concept .desktop-runbar button:hover:not(:disabled) { border-color: var(--claw-orange); }
    #storyclaw-gui-concept .desktop-runbar button:disabled { cursor: not-allowed; opacity: .45; }
    #storyclaw-gui-concept .desktop-run-start { border-color: transparent !important; background: var(--claw-gradient) !important; color: #1b0b02 !important; font-weight: 600; }
    #storyclaw-gui-concept .desktop-run-stop { color: #ff7b6f !important; }
    #storyclaw-gui-concept .desktop-run-log { position: absolute; right: 14px; bottom: -22px; max-width: 90%; overflow: hidden; color: var(--claw-dim); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    #storyclaw-gui-concept .desktop-empty { grid-column: 1 / -1; padding: 42px 16px; border: 1px dashed var(--claw-line); border-radius: 9px; color: var(--claw-muted); text-align: center; }
    #storyclaw-gui-concept .desktop-project-cover-fallback { display: grid; place-items: center; background: linear-gradient(135deg, #35110a, #9e2d16 52%, #f6a528); color: rgba(255,255,255,.82); font-size: 30px; }
    #storyclaw-gui-concept .desktop-project-option-empty { padding: 14px 10px; color: var(--claw-dim); font-size: 12px; }

    /* Keep the library views fixed to the window and move long content into its own pane. */
    #storyclaw-gui-concept .claw-floating-nav {
      top: 50%;
      transform: translateY(-50%);
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] {
      padding-top: 64px;
      overflow: hidden;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-page-title { margin-bottom: 44px; }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-grid {
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 16px;
      min-height: 0;
      max-height: calc(100% - 62px);
      overflow-x: hidden;
      overflow-y: auto;
      padding-right: 8px;
      scrollbar-gutter: stable;
      scrollbar-color: #45474b transparent;
      scrollbar-width: thin;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-grid::-webkit-scrollbar { width: 7px; }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-grid::-webkit-scrollbar-track { background: transparent; }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-grid::-webkit-scrollbar-thumb { border-radius: 7px; background: #45474b; }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-create-tile,
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-tile {
      min-height: 250px;
      border-radius: 12px;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-create-tile {
      display: grid;
      align-items: stretch;
      justify-items: stretch;
      padding: 0;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-create-center {
      display: grid;
      width: 100%;
      height: 100%;
      grid-template-rows: 140px minmax(0, 1fr);
      gap: 0;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-create-symbol {
      align-self: center;
      justify-self: center;
      width: 68px;
      height: 56px;
      border-radius: 12px;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-create-symbol svg { width: 28px; height: 28px; }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-create-cta {
      display: grid;
      width: 100%;
      min-width: 0;
      min-height: 0;
      align-items: center;
      justify-items: center;
      padding: 12px;
      border-top: 1px solid var(--claw-line);
      border-radius: 0 0 12px 12px;
      background: #292a2d;
      color: var(--claw-text);
      font-size: 16px;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-tile {
      grid-template-rows: 140px 1fr;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-cover {
      height: 140px;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-info {
      gap: 7px;
      padding: 12px;
    }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-name { font-size: 15px; }
    #storyclaw-gui-concept .claw-library-view[data-claw-view="projects"] .claw-project-date { font-size: 12px; }

    #storyclaw-gui-concept .claw-assets-view {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 16px;
      padding-top: 76px;
      overflow: hidden !important;
      overflow-y: hidden !important;
    }
    #storyclaw-gui-concept .claw-assets-view .claw-assets-head { margin-bottom: 0; }
    #storyclaw-gui-concept .claw-assets-view .claw-asset-layout {
      min-height: 0;
      height: 100%;
    }
    #storyclaw-gui-concept .claw-assets-view .claw-project-index {
      min-height: 0;
      overflow: hidden;
    }
    #storyclaw-gui-concept .claw-assets-view .claw-project-filter {
      height: 100%;
      max-height: none;
      min-height: 0;
    }
    #storyclaw-gui-concept .claw-assets-view .claw-asset-browser {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      min-height: 0;
      overflow: hidden;
    }
    #storyclaw-gui-concept .claw-assets-view .claw-reference-grid {
      min-height: 0;
      grid-auto-rows: max-content;
      align-content: start;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding-right: 8px;
      scrollbar-gutter: stable;
      scrollbar-color: #45474b transparent;
      scrollbar-width: thin;
    }
    #storyclaw-gui-concept .claw-assets-view .claw-reference-grid::-webkit-scrollbar { width: 7px; }
    #storyclaw-gui-concept .claw-assets-view .claw-reference-grid::-webkit-scrollbar-track { background: transparent; }
    #storyclaw-gui-concept .claw-assets-view .claw-reference-grid::-webkit-scrollbar-thumb { border-radius: 7px; background: #45474b; }
    #storyclaw-gui-concept .claw-assets-view .claw-reference-card {
      display: grid;
      min-height: 0;
      align-self: start;
      grid-template-rows: auto minmax(58px, auto);
    }
    #storyclaw-gui-concept .claw-assets-view .claw-reference-card img {
      width: 100%;
      height: auto;
      min-height: 0;
      aspect-ratio: 16 / 9;
      object-fit: contain;
      background: #26272a;
    }
    #storyclaw-gui-concept .claw-assets-view .claw-reference-meta {
      min-height: 58px;
      padding: 10px 12px;
    }
    #storyclaw-gui-concept .claw-editor {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) 140px;
      overflow: hidden !important;
    }
    #storyclaw-gui-concept .claw-editor-upper {
      height: auto;
      min-height: 0;
      overflow: hidden;
    }
    #storyclaw-gui-concept .claw-editor-upper > .claw-script-panel,
    #storyclaw-gui-concept .claw-editor-upper > .claw-preview-stage {
      min-height: 0;
    }
    #storyclaw-gui-concept .claw-editor-upper > .claw-script-panel {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    #storyclaw-gui-concept .claw-editor-upper .claw-script-list {
      height: auto;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      scrollbar-color: #45474b transparent;
      scrollbar-width: thin;
    }
    #storyclaw-gui-concept .claw-editor-upper .claw-script-list::-webkit-scrollbar { width: 7px; }
    #storyclaw-gui-concept .claw-editor-upper .claw-script-list::-webkit-scrollbar-track { background: transparent; }
    #storyclaw-gui-concept .claw-editor-upper .claw-script-list::-webkit-scrollbar-thumb { border-radius: 7px; background: #45474b; }
    #storyclaw-gui-concept .claw-editor-upper .claw-script-fade { display: none; }
    #storyclaw-gui-concept .claw-script-card { padding: 10px 12px 11px; }
    #storyclaw-gui-concept .claw-script-labels { gap: 10px; margin-bottom: 10px; }
    #storyclaw-gui-concept .claw-script-card p { margin: 0 0 10px; font-size: 14px; line-height: 1.55; }
    #storyclaw-gui-concept .claw-script-card p:last-child { margin-bottom: 0; }
    #storyclaw-gui-concept .claw-timeline {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 8px;
      height: auto;
      min-height: 0;
      overflow: hidden;
      padding-bottom: 0;
    }
    #storyclaw-gui-concept .claw-scrubber { margin-bottom: 0; }
    #storyclaw-gui-concept .claw-shot-strip {
      display: flex;
      min-height: 0;
      align-items: flex-end;
      overflow-x: auto;
      overflow-y: hidden;
      overscroll-behavior-x: contain;
      padding-bottom: 0;
      scrollbar-color: #45474b transparent;
      scrollbar-width: thin;
    }
    #storyclaw-gui-concept .claw-shot-strip::-webkit-scrollbar { height: 8px; }
    #storyclaw-gui-concept .claw-shot-strip::-webkit-scrollbar-track { background: transparent; }
    #storyclaw-gui-concept .claw-shot-strip::-webkit-scrollbar-thumb { border-radius: 8px; background: #45474b; }
    #storyclaw-gui-concept .claw-shot-placeholder {
      display: grid;
      width: 100%;
      aspect-ratio: 16 / 9;
      place-items: center;
      align-content: center;
      gap: 6px;
      background: #17181b;
      color: #8f9298;
      font-size: 11px;
    }
    #storyclaw-gui-concept .claw-shot-placeholder svg { width: 20px; height: 20px; }
    #storyclaw-gui-concept .claw-shot.is-pending .claw-shot-caption { color: #b8bac0; text-shadow: none; }
    #storyclaw-gui-concept .claw-timeline-scroll { display: none; }
    #storyclaw-gui-concept .claw-preview-image {
      width: min(980px, 92%);
      max-width: 100%;
      height: calc(100% - 50px);
      max-height: none;
      object-fit: contain;
    }

    /* The script panel collapses to a narrow rail so the preview keeps its width. */
    #storyclaw-gui-concept .claw-editor.is-script-collapsed .claw-editor-upper {
      grid-template-columns: 52px minmax(0, 1fr);
    }
    #storyclaw-gui-concept .claw-editor.is-script-collapsed .claw-script-head {
      display: flex;
      min-height: 100%;
      align-items: flex-start;
      justify-content: center;
      padding: 18px 6px;
      border-bottom: 0;
    }
    #storyclaw-gui-concept .claw-editor.is-script-collapsed .claw-script-head h2,
    #storyclaw-gui-concept .claw-editor.is-script-collapsed .claw-script-stats,
    #storyclaw-gui-concept .claw-editor.is-script-collapsed .claw-script-list { display: none; }
    #storyclaw-gui-concept .claw-editor.is-script-collapsed .claw-collapse {
      position: static;
      margin: 0;
    }
    #storyclaw-gui-concept .claw-editor.is-script-collapsed .claw-collapse svg { transform: rotate(180deg); }
    @media (max-height: 800px) { #storyclaw-gui-concept .desktop-runbar { bottom: 12px; } }
  `;
  // The concept page keeps a second style block near the document end; append
  // runtime overrides after it so the desktop layout remains authoritative.
  document.body.appendChild(style);

  const libraryScreen = root.querySelector('[data-claw-screen="library"]');
  const editorScreen = root.querySelector('[data-claw-screen="editor"]');
  const libraryViews = [...root.querySelectorAll("[data-claw-view]")];
  const toast = root.querySelector("[data-claw-toast]");

  function cleanLine(value) {
    return String(value || "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  }

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 2400);
  }

  function showLibraryView(page) {
    if (libraryScreen) libraryScreen.hidden = false;
    if (editorScreen) editorScreen.hidden = true;
    libraryViews.forEach((view) => { view.hidden = view.dataset.clawView !== page; });
    root.querySelectorAll("[data-claw-page]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.clawPage === page));
    });
  }

  function projectTitle(project) {
    return `${project.novelName} · 第 ${project.adaptedCount + 1} 集`;
  }

  function createProjectCard(project) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "claw-project-tile";
    card.dataset.desktopProject = project.id;
    const cover = document.createElement("span");
    cover.className = "claw-project-cover";
    if (project.cover) {
      cover.style.backgroundImage = `url(${project.cover})`;
      cover.style.backgroundSize = "cover";
      cover.style.backgroundPosition = "center";
    } else {
      cover.classList.add("desktop-project-cover-fallback");
      cover.textContent = "SC";
    }
    const info = document.createElement("span");
    info.className = "claw-project-info";
    const name = document.createElement("span");
    name.className = "claw-project-name";
    name.textContent = project.novelName;
    const date = document.createElement("span");
    date.className = "claw-project-date";
    date.textContent = project.episodeCount ? `已完成 ${project.episodeCount} 集 · 下一章 ${project.nextChapter}` : "尚未开始制作";
    info.append(name, date);
    card.append(cover, info);
    card.addEventListener("click", () => openProject(project));
    return card;
  }

  function renderProjects() {
    const grid = root.querySelector(".claw-project-grid");
    if (!grid) return;
    const createTile = grid.querySelector("[data-claw-view-target=home]");
    grid.replaceChildren();
    if (createTile) grid.appendChild(createTile);
    if (!state.projects.length) {
      const empty = document.createElement("div");
      empty.className = "desktop-empty";
      empty.textContent = "还没有项目，从左侧首页创建一个作品";
      grid.appendChild(empty);
      return;
    }
    state.projects.forEach((project) => grid.appendChild(createProjectCard(project)));
  }

  function renderAssetProjectOptions() {
    const filter = root.querySelector(".claw-project-filter");
    if (!filter) return;
    filter.replaceChildren();
    if (!state.projects.length) {
      const empty = document.createElement("div");
      empty.className = "desktop-project-option-empty";
      empty.textContent = "暂无项目";
      filter.appendChild(empty);
      return;
    }
    state.projects.forEach((project, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "claw-project-option";
      button.dataset.desktopAssetProject = project.id;
      button.setAttribute("aria-pressed", String(index === 0));
      const title = document.createElement("strong");
      title.textContent = project.novelName;
      const meta = document.createElement("span");
      meta.textContent = `${project.characterCount} 人物 · ${project.sceneCount} 场景`;
      button.append(title, meta);
      button.addEventListener("click", () => renderAssets(project));
      filter.appendChild(button);
    });
  }

  function makeAssetCard(item) {
    const article = document.createElement("article");
    article.className = "claw-reference-card";
    const image = document.createElement("img");
    image.alt = item.name;
    if (item.dataUrl) image.src = item.dataUrl;
    const meta = document.createElement("div");
    meta.className = "claw-reference-meta";
    const name = document.createElement("strong");
    name.textContent = item.name;
    const kind = document.createElement("span");
    kind.textContent = item.kind;
    meta.append(name, kind);
    article.append(image, meta);
    return article;
  }

  async function renderAssets(project) {
    if (!project) return;
    root.querySelectorAll("[data-desktop-asset-project]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.desktopAssetProject === project.id));
    });
    const title = root.querySelector("[data-claw-asset-project-title]");
    const meta = root.querySelector("[data-claw-asset-project-meta]");
    if (title) title.textContent = project.novelName;
    if (meta) meta.textContent = `${project.characterCount + project.sceneCount} 项资产 · 跨集共享`;
    try {
      const assets = await api.getAssets(project.novelName);
      const peoplePane = root.querySelector('[data-claw-asset-pane="people"]');
      const scenesPane = root.querySelector('[data-claw-asset-pane="scenes"]');
      if (peoplePane) {
        peoplePane.replaceChildren();
        (assets.people || []).forEach((item) => peoplePane.appendChild(makeAssetCard(item)));
        if (!assets.people?.length) peoplePane.innerHTML = '<div class="desktop-empty">暂无人物参考图</div>';
      }
      if (scenesPane) {
        scenesPane.replaceChildren();
        (assets.scenes || []).forEach((item) => scenesPane.appendChild(makeAssetCard(item)));
        if (!assets.scenes?.length) scenesPane.innerHTML = '<div class="desktop-empty">暂无场景参考图</div>';
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "读取资产失败");
    }
  }

  function formatPreviewTime(seconds) {
    const value = Number.isFinite(Number(seconds)) ? Math.max(0, Math.round(Number(seconds))) : 0;
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const remaining = value % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
  }

  function availableEpisodes(project) {
    const listed = Array.isArray(project?.episodeNumbers) ? project.episodeNumbers : [];
    const episodes = [...new Set(listed
      .map(Number)
      .filter((episode) => Number.isInteger(episode) && episode > 0))]
      .sort((a, b) => a - b);
    if (episodes.length) return episodes;
    const fallbackCount = Math.max(
      1,
      Math.trunc(Number(project?.latestEpisode) || 0),
      Math.trunc(Number(project?.adaptedCount) || 0),
    );
    return Array.from({ length: fallbackCount }, (_item, index) => index + 1);
  }

  function defaultPreviewEpisode(project) {
    const episodes = availableEpisodes(project);
    const latestCompleted = Math.trunc(Number(project?.adaptedCount) || 0);
    return latestCompleted > 0 && episodes.includes(latestCompleted)
      ? latestCompleted
      : episodes.at(-1) || 1;
  }

  function renderEpisodeOptions(project, selectedEpisode) {
    const projectName = root.querySelector("[data-claw-editor-project-name]");
    const select = root.querySelector("[data-claw-episode-select]");
    if (projectName) projectName.textContent = project?.novelName || "未命名项目";
    if (!select) return;

    const normalizedEpisode = Math.max(1, Math.trunc(Number(selectedEpisode) || 1));
    const episodes = availableEpisodes(project);
    if (!episodes.includes(normalizedEpisode)) episodes.push(normalizedEpisode);
    episodes.sort((a, b) => a - b);
    select.replaceChildren(...episodes.map((episode) => {
      const option = document.createElement("option");
      option.value = String(episode);
      option.textContent = `第 ${episode} 集`;
      return option;
    }));
    select.value = String(normalizedEpisode);
  }

  function setPreviewPlayIcon(playing) {
    const button = root.querySelector("[data-claw-play]");
    if (!button) return;
    button.dataset.playing = String(Boolean(playing));
    button.setAttribute("aria-label", playing ? "暂停" : "播放");
    button.innerHTML = `<i data-lucide="${playing ? "pause" : "play"}" aria-hidden="true"></i>`;
    window.lucide?.createIcons({ attrs: { width: 16, height: 16 } });
  }

  function updateFinalFilmButton() {
    const button = root.querySelector("[data-claw-final-film]");
    const regenerate = root.querySelector("[data-claw-regenerate]");
    if (!button) return;
    const showing = state.showingFinalFilm;
    if (regenerate) regenerate.hidden = showing;
    button.setAttribute("aria-pressed", String(showing));
    button.setAttribute("aria-label", showing ? "返回分镜预览" : "展示本集成片");
    button.innerHTML = `<i data-lucide="${showing ? "arrow-left" : "clapperboard"}" aria-hidden="true"></i><span>${showing ? "返回分镜" : "成片展示"}</span>`;
    window.lucide?.createIcons({ attrs: { width: 16, height: 16 } });
  }

  function finalFilmUrl(project, episode) {
    const episodeDir = `ep${String(Math.max(1, Math.trunc(Number(episode) || 1))).padStart(2, "0")}`;
    const projectDir = project.id || project.novelName;
    return new URL(
      `../../workspace/${encodeURIComponent(projectDir)}/${episodeDir}/${episodeDir}.mp4`,
      window.location.href,
    ).href;
  }

  function updatePreviewNavigation() {
    const hasItems = state.previewItems.length > 0;
    const previous = root.querySelector("[data-claw-prev]");
    const next = root.querySelector("[data-claw-next]");
    if (state.showingFinalFilm) {
      if (previous) previous.disabled = true;
      if (next) next.disabled = true;
      return;
    }
    if (previous) previous.disabled = !hasItems || state.previewIndex <= 0;
    if (next) next.disabled = !hasItems || state.previewIndex < 0 || state.previewIndex >= state.previewItems.length - 1;
  }

  function setPreviewItem(item, index) {
    const preview = root.querySelector("[data-claw-preview]");
    const range = root.querySelector(".claw-range");
    const current = root.querySelector("[data-claw-current-time]");
    const duration = root.querySelector("[data-claw-duration]");
    const play = root.querySelector("[data-claw-play]");
    const scriptLabel = root.querySelector("[data-claw-script-label]");
    const scriptLead = root.querySelector(".claw-script-labels strong");
    const scriptParagraphs = [...root.querySelectorAll(".claw-script-card p")];
    if (!preview || !item) return;
    state.showingFinalFilm = false;
    state.previewIndex = index;
    updateFinalFilmButton();
    root.querySelectorAll(".claw-shot-strip .claw-shot").forEach((shot, shotIndex) => {
      shot.setAttribute("aria-pressed", String(shotIndex === index));
    });
    if (scriptLabel) scriptLabel.textContent = `分镜${String(index + 1).padStart(2, "0")}`;
    if (scriptLead) scriptLead.textContent = "";
    scriptParagraphs.forEach((paragraph, paragraphIndex) => {
      paragraph.textContent = paragraphIndex === 0 ? item.scriptText || "" : "";
      paragraph.hidden = paragraphIndex !== 0;
    });
    preview.pause?.();
    preview.dataset.previewMode = "panel";
    preview.dataset.videoUrl = item.videoUrl || "";
    preview.poster = item.dataUrl || "";
    preview.classList.toggle("is-pending", !item.dataUrl && !item.videoUrl);
    preview.setAttribute("aria-label", item.name || "当前分镜预览");
    preview.removeAttribute("src");
    if (item.videoUrl) preview.src = item.videoUrl;
    preview.load?.();
    setPreviewPlayIcon(false);
    if (play) play.disabled = !item.videoUrl;
    if (range) {
      range.value = "0";
      range.max = "0";
      range.disabled = !item.videoUrl;
    }
    if (current) current.textContent = formatPreviewTime(0);
    if (duration) duration.textContent = " / 00:00:00";
    updatePreviewNavigation();
  }

  function toggleFinalFilm() {
    if (state.showingFinalFilm) {
      const index = state.previewIndex >= 0 ? state.previewIndex : 0;
      const item = state.previewItems[index];
      if (item) setPreviewItem(item, index);
      return;
    }

    const project = state.selectedProject;
    const preview = root.querySelector("[data-claw-preview]");
    if (!project || !preview) return;

    const episode = Math.max(1, Math.trunc(Number(state.selectedEpisode) || 1));
    const videoUrl = finalFilmUrl(project, episode);
    const range = root.querySelector(".claw-range");
    const current = root.querySelector("[data-claw-current-time]");
    const duration = root.querySelector("[data-claw-duration]");
    const play = root.querySelector("[data-claw-play]");
    const scriptLabel = root.querySelector("[data-claw-script-label]");
    const scriptLead = root.querySelector(".claw-script-labels strong");
    const scriptParagraphs = [...root.querySelectorAll(".claw-script-card p")];

    state.showingFinalFilm = true;
    updateFinalFilmButton();
    updatePreviewNavigation();
    root.querySelectorAll(".claw-shot-strip .claw-shot").forEach((shot) => shot.setAttribute("aria-pressed", "false"));
    if (scriptLabel) scriptLabel.textContent = "成片";
    if (scriptLead) scriptLead.textContent = "";
    scriptParagraphs.forEach((paragraph, paragraphIndex) => {
      paragraph.textContent = paragraphIndex === 0 ? `第 ${episode} 集完整成片` : "";
      paragraph.hidden = paragraphIndex !== 0;
    });

    preview.pause?.();
    preview.dataset.previewMode = "final";
    preview.dataset.videoUrl = videoUrl;
    preview.poster = "";
    preview.classList.remove("is-pending");
    preview.setAttribute("aria-label", `${project.novelName} 第 ${episode} 集成片`);
    preview.removeAttribute("src");
    preview.src = videoUrl;
    preview.load?.();
    setPreviewPlayIcon(false);
    if (play) play.disabled = false;
    if (range) {
      range.value = "0";
      range.max = "0";
      range.disabled = true;
    }
    if (current) current.textContent = formatPreviewTime(0);
    if (duration) duration.textContent = " / 00:00:00";
  }

  function resetPreviewSurface(message) {
    const preview = root.querySelector("[data-claw-preview]");
    const range = root.querySelector(".claw-range");
    const current = root.querySelector("[data-claw-current-time]");
    const duration = root.querySelector("[data-claw-duration]");
    const play = root.querySelector("[data-claw-play]");
    const scriptLabel = root.querySelector("[data-claw-script-label]");
    const scriptLead = root.querySelector(".claw-script-labels strong");
    const scriptParagraphs = [...root.querySelectorAll(".claw-script-card p")];
    if (preview) {
      preview.pause?.();
      preview.dataset.previewMode = "panel";
      preview.dataset.videoUrl = "";
      preview.poster = "";
      preview.classList.add("is-pending");
      preview.setAttribute("aria-label", message);
      preview.removeAttribute("src");
      preview.load?.();
    }
    if (play) play.disabled = true;
    if (range) {
      range.value = "0";
      range.max = "0";
      range.disabled = true;
    }
    if (current) current.textContent = formatPreviewTime(0);
    if (duration) duration.textContent = " / 00:00:00";
    if (scriptLabel) scriptLabel.textContent = "分镜";
    if (scriptLead) scriptLead.textContent = "";
    scriptParagraphs.forEach((paragraph, paragraphIndex) => {
      paragraph.textContent = paragraphIndex === 0 ? message : "";
      paragraph.hidden = paragraphIndex !== 0;
    });
    setPreviewPlayIcon(false);
    updatePreviewNavigation();
  }

  function renderShots(images, options = {}) {
    const {
      emptyMessage = "本集暂未生成分镜",
      totalDuration: episodeDuration = null,
    } = options;
    const strip = root.querySelector(".claw-shot-strip");
    if (!strip) return;
    state.previewItems = Array.isArray(images) ? images : [];
    state.previewIndex = -1;
    state.showingFinalFilm = false;
    updateFinalFilmButton();
    const shotCount = root.querySelector("[data-claw-shot-count]");
    if (shotCount) shotCount.textContent = String(state.previewItems.length);
    const totalDuration = root.querySelector("[data-claw-total-duration]");
    const durationSeconds = Number(episodeDuration);
    if (totalDuration) {
      totalDuration.textContent = Number.isFinite(durationSeconds) && durationSeconds > 0
        ? formatPreviewTime(durationSeconds)
        : "--:--:--";
    }
    strip.replaceChildren();
    state.previewItems.forEach((item, index) => {
      const shot = document.createElement("button");
      shot.type = "button";
      shot.className = "claw-shot";
      shot.classList.toggle("is-pending", !item.dataUrl && !item.videoUrl);
      shot.setAttribute("aria-pressed", String(index === 0));
      let visual;
      if (item.dataUrl) {
        visual = document.createElement("img");
        visual.src = item.dataUrl;
        visual.alt = item.name;
        visual.loading = "lazy";
      } else {
        visual = document.createElement("span");
        visual.className = "claw-shot-placeholder";
        visual.innerHTML = item.videoUrl
          ? '<i data-lucide="clapperboard" aria-hidden="true"></i><span>视频已生成</span>'
          : '<i data-lucide="image-off" aria-hidden="true"></i><span>暂未生成</span>';
      }
      const caption = document.createElement("span");
      caption.className = "claw-shot-caption";
      const label = document.createElement("strong");
      label.textContent = `分镜${String(index + 1).padStart(2, "0")}`;
      const scene = document.createElement("span");
      scene.textContent = item.scene || "";
      caption.append(label, scene);
      shot.append(visual, caption);
      shot.addEventListener("click", () => {
        strip.querySelectorAll(".claw-shot").forEach((peer) => peer.setAttribute("aria-pressed", String(peer === shot)));
        setPreviewItem(item, index);
      });
      strip.appendChild(shot);
    });
    window.lucide?.createIcons({ attrs: { width: 16, height: 16 } });
    if (state.previewItems.length > 0) setPreviewItem(state.previewItems[0], 0);
    else resetPreviewSurface(emptyMessage);
  }

  async function loadEpisodePreview(project, episode) {
    if (!project) return;
    const normalizedEpisode = Math.max(1, Math.trunc(Number(episode) || 1));
    const loadId = ++state.previewLoadId;
    const select = root.querySelector("[data-claw-episode-select]");
    state.selectedEpisode = normalizedEpisode;
    renderEpisodeOptions(project, normalizedEpisode);
    renderShots([], { emptyMessage: "正在读取本集分镜…" });
    if (select) {
      select.disabled = true;
      select.setAttribute("aria-busy", "true");
    }

    try {
      const previewData = await api.getEpisodePreview(project.novelName, normalizedEpisode);
      if (loadId !== state.previewLoadId || state.selectedProject?.id !== project.id) return;
      const images = Array.isArray(previewData) ? previewData : previewData?.panels;
      const totalDuration = Array.isArray(previewData) ? null : previewData?.totalDuration;
      renderShots(images, { totalDuration });
    } catch (error) {
      if (loadId !== state.previewLoadId || state.selectedProject?.id !== project.id) return;
      renderShots([]);
      showToast(error instanceof Error ? error.message : "读取分镜失败");
    } finally {
      if (loadId === state.previewLoadId && select) {
        select.disabled = false;
        select.removeAttribute("aria-busy");
      }
    }
  }

  async function openProject(project) {
    const previousEpisode = state.selectedProject?.id === project.id ? state.selectedEpisode : null;
    state.selectedProject = project;
    state.renderMode = project.renderMode === "full" ? "full" : "images_only";
    showLibraryView("projects");
    if (libraryScreen) libraryScreen.hidden = true;
    if (editorScreen) editorScreen.hidden = false;
    const episodes = availableEpisodes(project);
    const previewEpisode = previousEpisode && episodes.includes(previousEpisode)
      ? previousEpisode
      : defaultPreviewEpisode(project);
    await loadEpisodePreview(project, previewEpisode);
  }

  function makeSelection() {
    const project = state.selectedProject;
    if (!project) throw new Error("请先选择一个项目");
    return {
      novelName: project.novelName,
      sourcePath: project.sourcePath,
      episode: project.adaptedCount + 1,
      nextChapter: project.nextChapter,
      ethnicity: "",
      aspectRatio: project.aspectRatio || "9:16",
      imagesOnly: state.renderMode === "images_only",
      articleType: project.articleType || "story",
    };
  }

  function updateRunbar() {
    const bar = root.querySelector(".desktop-runbar");
    if (!bar) return;
    const project = state.selectedProject;
    const homeView = root.querySelector('[data-claw-view="home"]');
    const homeVisible = Boolean(libraryScreen && !libraryScreen.hidden && homeView && !homeView.hidden);
    const editorVisible = Boolean(editorScreen && !editorScreen.hidden);
    bar.hidden = !project || homeVisible || !editorVisible;
    const title = bar.querySelector(".desktop-run-title");
    const status = bar.querySelector(".desktop-run-status");
    const start = bar.querySelector(".desktop-run-start");
    const stop = bar.querySelector(".desktop-run-stop");
    const mode = bar.querySelector("#desktop-render-mode");
    if (title) title.textContent = project ? projectTitle(project) : "未选择项目";
    if (status) status.textContent = state.running ? state.running.statusText : state.lastLog;
    if (mode) mode.value = state.renderMode;
    const active = Boolean(state.running && ["running", "stopping"].includes(state.running.status));
    if (start) start.disabled = active || !project;
    if (stop) stop.disabled = !active;
  }

  async function startRun() {
    try {
      if (state.running) return;
      const selection = makeSelection();
      const result = await api.startRun(selection);
      state.running = { runId: result.runId, status: "running", statusText: "任务启动中…" };
      state.lastLog = "任务启动中…";
      updateRunbar();
      showToast("已开始运行，进度会实时显示在下方");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "启动任务失败");
    }
  }

  async function stopRun() {
    try {
      await api.stopRun();
      if (state.running) state.running = { ...state.running, status: "stopping", statusText: "正在停止任务…" };
      updateRunbar();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "停止任务失败");
    }
  }

  function injectRunbar() {
    if (root.querySelector(".desktop-runbar")) return;
    const bar = document.createElement("div");
    bar.className = "desktop-runbar";
    bar.innerHTML = `
      <div class="desktop-run-copy"><strong class="desktop-run-title">未选择项目</strong><span class="desktop-run-status">选择项目后可以运行现有流水线</span></div>
      <select id="desktop-render-mode" aria-label="渲染模式"><option value="images_only">只生成分镜图</option><option value="full">完整渲染</option></select>
      <button type="button" class="desktop-run-start"><span>运行</span></button>
      <button type="button" class="desktop-run-stop" disabled><span>停止</span></button>
      <button type="button" class="desktop-run-output"><span>产物目录</span></button>
      <span class="desktop-run-log"></span>`;
    root.querySelector(".claw-app")?.appendChild(bar);
    bar.querySelector(".desktop-run-start")?.addEventListener("click", startRun);
    bar.querySelector(".desktop-run-stop")?.addEventListener("click", stopRun);
    bar.querySelector(".desktop-run-output")?.addEventListener("click", async () => {
      if (!state.selectedProject) return showToast("请先选择一个项目");
      await api.openOutput(state.selectedProject.novelName, state.selectedProject.adaptedCount + 1);
    });
    bar.querySelector("#desktop-render-mode")?.addEventListener("change", (event) => {
      state.renderMode = event.currentTarget.value === "full" ? "full" : "images_only";
    });
  }

  async function chooseInput(kind) {
    try {
      const selected = await api.chooseSource(kind);
      if (!selected) return;
      state.pendingInput = selected;
      const status = root.querySelector("[data-claw-upload-status]");
      if (status) {
        status.textContent = selected.kind === "directory" ? `已选择文件夹：${selected.path}` : `已选择文件：${selected.path}`;
        status.hidden = false;
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "选择文件失败");
    }
  }

  function defaultProjectName(text) {
    const selectedPath = state.pendingInput?.path;
    if (selectedPath) {
      const leaf = selectedPath.split(/[\\/]/).pop() || "";
      const name = leaf.replace(/\.[^.]+$/, "").trim();
      if (name) return name.slice(0, 80);
    }
    const firstLine = String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return (firstLine || "未命名作品").slice(0, 80);
  }

  async function createProject() {
    const text = root.querySelector(".claw-compose-textarea")?.value || "";
    const name = defaultProjectName(text);
    if (!state.pendingInput && !text.trim()) return showToast("请选择章节文件夹、章节文件或输入文稿");
    try {
      const project = await api.createProject({
        name,
        text,
        inputPath: state.pendingInput?.path,
        inputKind: state.pendingInput?.kind,
        articleType: "story",
        aspectRatio: "9:16",
        renderMode: "images_only",
      });
      state.pendingInput = null;
      state.projects = await api.getProjects();
      renderProjects();
      renderAssetProjectOptions();
      showToast(`项目“${project.novelName || name}”已创建`);
      const fresh = state.projects.find((item) => item.id === project.id) || project;
      await openProject(fresh);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "创建项目失败");
    }
  }

  function bindPreviewControls() {
    const editor = editorScreen;
    const preview = root.querySelector("[data-claw-preview]");
    const play = root.querySelector("[data-claw-play]");
    const previous = root.querySelector("[data-claw-prev]");
    const next = root.querySelector("[data-claw-next]");
    const range = root.querySelector(".claw-range");
    const current = root.querySelector("[data-claw-current-time]");
    const duration = root.querySelector("[data-claw-duration]");
    const collapse = root.querySelector("[data-claw-collapse]");
    const finalFilm = root.querySelector("[data-claw-final-film]");
    if (!preview || !play || !range) return;

    const selectPreview = (index) => {
      const shot = root.querySelectorAll(".claw-shot")[index];
      shot?.click();
      shot?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    };

    if (collapse && collapse.dataset.clawRuntimeBound !== "true") {
      collapse.dataset.clawRuntimeBound = "true";
      collapse.addEventListener("click", () => {
        const collapsed = editor?.classList.toggle("is-script-collapsed") || false;
        collapse.setAttribute("aria-expanded", String(!collapsed));
        collapse.setAttribute("aria-label", collapsed ? "展开文稿" : "收起文稿");
        collapse.innerHTML = `<i data-lucide="${collapsed ? "panel-left-open" : "panel-left-close"}" aria-hidden="true"></i>`;
        window.lucide?.createIcons({ attrs: { width: 16, height: 16 } });
      });
    }

    play.dataset.clawRuntimeBound = "true";
    play.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!preview.dataset.videoUrl) return showToast("当前分镜还没有可播放的视频");
      try {
        if (preview.paused) await preview.play();
        else preview.pause();
      } catch (error) {
        setPreviewPlayIcon(false);
        showToast(error instanceof Error ? error.message : "视频播放失败");
      }
    });

    previous?.addEventListener("click", () => selectPreview(Math.max(0, state.previewIndex - 1)));
    next?.addEventListener("click", () => selectPreview(Math.min(state.previewItems.length - 1, state.previewIndex + 1)));
    finalFilm?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleFinalFilm();
    });

    range.dataset.clawRuntimeBound = "true";
    range.addEventListener("input", (event) => {
      event.stopImmediatePropagation();
      if (!preview.dataset.videoUrl) return;
      preview.currentTime = Number(range.value) || 0;
      if (current) current.textContent = formatPreviewTime(preview.currentTime);
    });

    preview.addEventListener("loadedmetadata", () => {
      const total = Number.isFinite(preview.duration) ? preview.duration : 0;
      range.max = String(total);
      range.disabled = !total;
      if (duration) duration.textContent = ` / ${formatPreviewTime(total)}`;
      if (preview.dataset.previewMode === "final") {
        const totalDuration = root.querySelector("[data-claw-total-duration]");
        if (totalDuration) totalDuration.textContent = formatPreviewTime(total);
      }
    });
    preview.addEventListener("timeupdate", () => {
      if (current) current.textContent = formatPreviewTime(preview.currentTime);
      if (Number.isFinite(preview.duration)) range.value = String(preview.currentTime);
    });
    preview.addEventListener("play", () => setPreviewPlayIcon(true));
    preview.addEventListener("pause", () => setPreviewPlayIcon(false));
    preview.addEventListener("ended", () => setPreviewPlayIcon(false));
    preview.addEventListener("error", () => {
      if (!preview.dataset.videoUrl) return;
      setPreviewPlayIcon(false);
      if (preview.dataset.previewMode === "final") {
        const episode = state.selectedEpisode;
        const index = state.previewIndex >= 0 ? state.previewIndex : 0;
        const item = state.previewItems[index];
        if (item) setPreviewItem(item, index);
        else {
          state.showingFinalFilm = false;
          updateFinalFilmButton();
          updatePreviewNavigation();
          preview.dataset.videoUrl = "";
          preview.removeAttribute("src");
          preview.load?.();
        }
        showToast(`第 ${episode} 集暂未生成成片`);
        return;
      }
      showToast("当前分镜视频无法加载");
    });
    updatePreviewNavigation();
  }

  function bindInteractions() {
    bindPreviewControls();
    root.querySelector("[data-claw-episode-select]")?.addEventListener("change", (event) => {
      if (!state.selectedProject) return;
      loadEpisodePreview(state.selectedProject, event.currentTarget.value);
    });
    root.querySelectorAll("[data-claw-page]").forEach((button) => {
      button.addEventListener("click", () => {
        const page = button.dataset.clawPage;
        showLibraryView(page);
        if (page === "assets") {
          const project = state.selectedProject || state.projects[0];
          if (project) renderAssets(project);
        }
      });
    });
    root.querySelectorAll("[data-claw-view-target=home]").forEach((button) => {
      button.addEventListener("click", (event) => { event.preventDefault(); showLibraryView("home"); });
    });
    root.querySelector("[data-claw-back]")?.addEventListener("click", (event) => {
      event.preventDefault(); showLibraryView("projects");
    });
    root.querySelector("[data-claw-create]")?.addEventListener("click", (event) => {
      event.preventDefault(); event.stopImmediatePropagation(); createProject();
    }, true);
    root.querySelector("[data-claw-upload-menu]")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-claw-open-input]");
      if (!button) return;
      event.preventDefault(); event.stopImmediatePropagation();
      chooseInput(button.dataset.clawOpenInput === "file" ? "file" : "directory");
    }, true);
    root.querySelector("[data-claw-upload-pick]")?.addEventListener("drop", async (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (!file?.path) return;
      event.preventDefault(); event.stopImmediatePropagation();
      try {
        const selected = await api.inspectSource(file.path);
        if (!selected) throw new Error("拖拽项不是可用的文件或文件夹");
        state.pendingInput = selected;
        const status = root.querySelector("[data-claw-upload-status]");
        if (status) {
          status.textContent = selected.kind === "directory" ? `已选择文件夹：${selected.path}` : `已选择文件：${selected.path}`;
          status.hidden = false;
        }
        showToast(selected.kind === "directory" ? "已添加章节文件夹" : "已添加章节文件");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "读取拖拽项失败");
      }
    }, true);
    root.querySelector("[data-claw-upload-pick]")?.addEventListener("dragover", (event) => event.preventDefault(), true);
  }

  api.onRunLog((event) => {
    const line = cleanLine(event?.line);
    if (!line) return;
    state.lastLog = line;
    const bar = root.querySelector(".desktop-runbar");
    const log = bar?.querySelector(".desktop-run-log");
    if (log) log.textContent = line;
    const status = bar?.querySelector(".desktop-run-status");
    if (status && state.running) status.textContent = line;
  });

  api.onRunState(async (event) => {
    if (!event || (state.running && event.runId !== state.running.runId)) return;
    if (event.status === "running") {
      state.running = { runId: event.runId, status: "running", statusText: "运行中…" };
    } else if (["stopping", "stopped"].includes(event.status)) {
      state.running = event.status === "stopping" ? { ...state.running, status: "stopping", statusText: "正在停止任务…" } : null;
      if (event.status === "stopped") showToast("任务已停止，已保留当前进度");
    } else {
      const message = event.status === "done" ? "任务完成" : "任务失败，请查看运行日志";
      state.running = null;
      state.lastLog = message;
      showToast(message);
      state.projects = await api.getProjects();
      renderProjects();
      renderAssetProjectOptions();
      if (state.selectedProject) {
        state.selectedProject = state.projects.find((project) => project.id === state.selectedProject.id) || state.selectedProject;
        openProject(state.selectedProject);
      }
    }
    updateRunbar();
  });

  async function init() {
    bindInteractions();
    try {
      state.projects = await api.getProjects();
      renderProjects();
      renderAssetProjectOptions();
      const activeRun = await api.getActiveRun();
      if (activeRun) {
        state.running = {
          runId: activeRun.runId,
          status: activeRun.status === "stopping" ? "stopping" : "running",
          statusText: activeRun.status === "stopping" ? "正在停止任务…" : "运行中…",
        };
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "读取项目失败");
    }
  }

  init();
})();
