(() => {
  const menuToggle = document.querySelector(".menu-toggle");
  const mobileMenu = document.querySelector("[data-mobile-menu]");

  const closeMenu = () => {
    if (!menuToggle || !mobileMenu) return;
    menuToggle.setAttribute("aria-expanded", "false");
    mobileMenu.classList.remove("is-open");
  };

  menuToggle?.addEventListener("click", () => {
    const isOpen = menuToggle.getAttribute("aria-expanded") === "true";
    menuToggle.setAttribute("aria-expanded", String(!isOpen));
    mobileMenu?.classList.toggle("is-open", !isOpen);
  });

  mobileMenu?.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });

  const navLinks = [...document.querySelectorAll(".nav-links a")];
  const sections = navLinks
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean);

  if ("IntersectionObserver" in window && sections.length) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          navLinks.forEach((link) => {
            link.classList.toggle("is-active", link.getAttribute("href") === "#" + entry.target.id);
          });
        });
      },
      { rootMargin: "-35% 0px -58% 0px", threshold: 0 },
    );
    sections.forEach((section) => observer.observe(section));
  }

  const dialog = document.querySelector("[data-lightbox-dialog]");
  const lightboxImage = document.querySelector("[data-lightbox-image]");
  const lightboxCaption = document.querySelector("[data-lightbox-caption]");
  const lightboxClose = document.querySelector("[data-lightbox-close]");

  const closeLightbox = () => {
    if (!dialog) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  };

  document.querySelectorAll("[data-lightbox]").forEach((trigger) => {
    trigger.addEventListener("click", () => {
      if (!dialog || !lightboxImage) return;
      lightboxImage.src = trigger.dataset.lightbox;
      lightboxImage.alt = trigger.closest("figure")?.querySelector("img")?.alt || "Story Claw 界面截图";
      if (lightboxCaption) lightboxCaption.textContent = trigger.dataset.caption || "";
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    });
  });

  lightboxClose?.addEventListener("click", closeLightbox);
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) closeLightbox();
  });

  const copyButton = document.querySelector("[data-copy]");
  const feedback = document.querySelector("[data-copy-feedback]");

  const copyText = async (value) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const helper = document.createElement("textarea");
    helper.value = value;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
  };

  copyButton?.addEventListener("click", async () => {
    const value = copyButton.dataset.copy || "";
    try {
      await copyText(value);
      copyButton.textContent = "已复制";
      if (feedback) feedback.textContent = "命令已复制到剪贴板。";
    } catch {
      copyButton.textContent = "复制失败";
      if (feedback) feedback.textContent = "请手动选择命令复制。";
    }
    window.setTimeout(() => {
      copyButton.textContent = "复制命令";
      if (feedback) feedback.textContent = "";
    }, 2200);
  });

  const nav = document.querySelector("[data-nav]");
  const updateNav = () => nav?.classList.toggle("is-scrolled", window.scrollY > 12);
  updateNav();
  window.addEventListener("scroll", updateNav, { passive: true });

  const starTargets = [...document.querySelectorAll("[data-github-stars]")];
  const starLinks = [...document.querySelectorAll("[data-github-stars-link]")];
  const starStatus = document.querySelector("[data-github-stars-status]");
  const githubRepo = "ZC89757/story-claw";
  const fallbackStars = "15";

  const formatStars = (count) => new Intl.NumberFormat("zh-CN").format(count);

  const updateStars = (count) => {
    const formatted = formatStars(count);
    starTargets.forEach((target) => {
      target.textContent = formatted;
      target.dataset.githubStarsLoaded = "true";
    });
    starLinks.forEach((link) => {
      link.setAttribute("aria-label", `GitHub Stars：${formatted}，打开查看最新数据`);
    });
    if (starStatus) starStatus.textContent = "刚刚从 GitHub 读取";
  };

  const markStarsUnavailable = () => {
    starTargets.forEach((target) => {
      target.textContent = target.dataset.fallbackStars || fallbackStars;
      target.dataset.githubStarsLoaded = "false";
    });
    starLinks.forEach((link) => {
      link.setAttribute("aria-label", "GitHub Stars 暂时无法读取，打开查看");
    });
    if (starStatus) starStatus.textContent = "GitHub 暂时不可用，点击查看最新数据";
  };

  if (starTargets.length) {
    starTargets.forEach((target) => {
      target.textContent = target.dataset.fallbackStars || fallbackStars;
    });
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    fetch(`https://api.github.com/repos/${githubRepo}`, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`GitHub API ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (!Number.isFinite(data?.stargazers_count)) throw new Error("Invalid star count");
        updateStars(data.stargazers_count);
      })
      .catch(() => markStarsUnavailable())
      .finally(() => window.clearTimeout(timeout));
  }

  const workflowSlides = [...document.querySelectorAll("[data-workflow-carousel] .workflow-slide")];
  const workflowSteps = [...document.querySelectorAll(".pipeline li")];
  const workflowPrev = document.querySelector("[data-workflow-prev]");
  const workflowNext = document.querySelector("[data-workflow-next]");
  const chapterStack = document.querySelector("[data-chapter-stack]");
  const chapterCards = chapterStack ? [...chapterStack.querySelectorAll("[data-chapter-card]")] : [];
  let workflowIndex = 0;
  let chapterSwapped = false;
  let chapterSwapLocked = false;

  const syncChapterStack = () => {
    if (!chapterStack || chapterCards.length < 2) return;
    chapterStack.classList.toggle("is-swapped", chapterSwapped);
    const frontChapter = chapterSwapped ? "2" : "1";
    chapterCards.forEach((card) => {
      const isFront = card.dataset.chapterCard === frontChapter;
      card.dataset.position = isFront ? "front" : "back";
      card.tabIndex = isFront ? -1 : 0;
      card.style.pointerEvents = isFront ? "none" : "auto";
      card.setAttribute("aria-label", `点击将第 ${card.dataset.chapterCard} 章切换到上面`);
    });
  };

  const swapChapter = () => {
    if (!chapterStack || chapterCards.length < 2 || chapterSwapLocked) return;
    chapterSwapped = !chapterSwapped;
    syncChapterStack();
    chapterSwapLocked = true;
    window.setTimeout(() => {
      chapterSwapLocked = false;
    }, 380);
  };

  chapterCards.forEach((card) => card.addEventListener("click", swapChapter));
  syncChapterStack();

  const setWorkflow = (index) => {
    if (!workflowSlides.length || !workflowSteps.length) return;
    workflowIndex = (index + workflowSlides.length) % workflowSlides.length;
    workflowSlides.forEach((slide, i) => slide.classList.toggle("is-active", i === workflowIndex));
    workflowSteps.forEach((step, i) => step.classList.toggle("is-active", i === workflowIndex));
  };
  workflowSteps.forEach((step, index) => step.addEventListener("click", () => setWorkflow(index)));
  workflowPrev?.addEventListener("click", () => setWorkflow(workflowIndex - 1));
  workflowNext?.addEventListener("click", () => setWorkflow(workflowIndex + 1));
  if (workflowSlides.length && workflowSteps.length) setWorkflow(0);
})();
