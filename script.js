"use strict";

document.addEventListener("DOMContentLoaded", () => {

    const themeSwitcher = document.getElementById("theme-switcher");
    const rootElement = document.documentElement;

    const applyTheme = (themeName) => {
        rootElement.setAttribute("data-theme", themeName);
        localStorage.setItem("portfolio-theme", themeName);
    };

    const determineInitialTheme = () => {
        applyTheme("dark");
    };

    if (themeSwitcher) {
        themeSwitcher.addEventListener("click", () => {
            const currentTheme = rootElement.getAttribute("data-theme");
            applyTheme(currentTheme === "light" ? "dark" : "light");
        });
    }

    determineInitialTheme();

    const scrollObserverOptions = {
        root: null,
        rootMargin: "0px 0px -50px 0px",
        threshold: 0.1
    };

    const scrollObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add("active");
            } else {
                entry.target.classList.remove("active");
            }
        });
    }, scrollObserverOptions);

    const observeElements = () => {
        document.querySelectorAll(".reveal-element").forEach(el => scrollObserver.observe(el));
    };

    observeElements();

    const typeWriterEffect = (elementId, texts, speed = 60, pause = 2000) => {
        const element = document.getElementById(elementId);
        if (!element) return;

        let textIndex = 0;
        let charIndex = 0;
        let isDeleting = false;

        const type = () => {
            const currentText = texts[textIndex];

            if (isDeleting) {
                element.setAttribute("placeholder", currentText.substring(0, charIndex - 1));
                charIndex--;
            } else {
                element.setAttribute("placeholder", currentText.substring(0, charIndex + 1));
                charIndex++;
            }

            let delay = speed;

            if (isDeleting) {
                delay /= 2;
            }

            if (!isDeleting && charIndex === currentText.length) {
                delay = pause;
                isDeleting = true;
            } else if (isDeleting && charIndex === 0) {
                isDeleting = false;
                textIndex = (textIndex + 1) % texts.length;
                delay = speed * 3;
            }

            setTimeout(type, delay);
        };

        setTimeout(type, speed * 3);
    };

    typeWriterEffect("sender-email", ["name@company.com", "hello@startup.io", "recruiter@agency.com"]);
    typeWriterEffect("sender-message", ["How can we collaborate?", "I have a role for you...", "Let's build something."]);

    const searchInput = document.getElementById("project-search");
    const languageSelect = document.getElementById("project-language");
    const sortSelect = document.getElementById("project-sort");

    const featuredProjectsContainer = document.getElementById("featured-projects-grid");
    const otherProjectsContainer = document.getElementById("other-projects-grid");
    const featuredSection = document.getElementById("featured-section");
    const otherSection = document.getElementById("other-section");
    const emptyState = document.getElementById("empty-state");

    const icons = {
        webapp: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path><path d="M2 12h20"></path></svg> Live Web Demo',
        terminal: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" x2="20" y1="19" y2="19"></line></svg> Terminal',
        desktopApp: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="14" x="2" y="3" rx="2"></rect><line x1="8" x2="16" y1="21" y2="21"></line><line x1="12" x2="12" y1="17" y2="21"></line></svg> Desktop App',
        Python: '<svg viewBox="0 0 448 512" width="14" height="14" fill="currentColor"><path d="M439.8 200.5c-7.7-30.9-22.3-54.2-53.4-54.2h-40.1v47.4c0 36.8-31.2 67.8-66.8 67.8H172.7c-29.2 0-53.4 25-53.4 54.3v101.8c0 29 25.2 46 53.4 54.3 33.8 9.9 66.3 11.7 106.8 0 26.9-7.8 53.4-23.5 53.4-54.3v-40.7H226.2v-13.6h160.2c31.1 0 42.6-21.7 53.4-54.2 11.2-33.5 10.7-65.7 0-108.6zM286.2 404c11.1 0 20.1 9.1 20.1 20.3 0 11.3-9 20.4-20.1 20.4-11 0-20.1-9.2-20.1-20.4 .1-11.3 9.1-20.3 20.1-20.3zM167.8 248.1h106.8c29.7 0 53.4-24.5 53.4-54.3V91.9c0-29-24.4-50.7-53.4-55.6C258.2 22.4 226.5 22.2 192 33.1c-29.4 9.4-53.4 26.5-53.4 55.6v40.7h106.9v13.6h-170.3c-31.8 0-46 21.8-53.4 54.2-11.2 33.2-10.7 65.7 0 108.6 7.6 30.9 22.3 54.2 53.4 54.2H106v-48.8c0-35.8 31.1-67.8 66.8-67.8h6.5c-.2 0-.2 0-.2 0zM137.4 83.3c0-11.2 9.1-20.4 20.1-20.4 11.1 0 20.1 9.1 20.1 20.4s-9 20.3-20.1 20.3c-11 0-20.1-9.2-20.1-20.3z"/></svg>',
        JavaScript: '<svg viewBox="0 0 448 512" width="14" height="14" fill="currentColor"><path d="M0 32v448h448V32H0zm243.8 349.4c0 43.6-25.6 63.5-62.9 63.5-33.7 0-53.2-17.4-63.2-38.5l34.3-20.7c6.6 11.7 12.6 21.6 27.1 21.6 13.8 0 22.6-5.4 22.6-26.5V237.7h42.1v144.1zm99.6 63.5c-39.1 0-64.4-18.6-76.7-43l34.3-19.8c9 14.7 20.8 25.6 41.5 25.6 17.4 0 28.6-8.7 28.6-20.8 0-14.4-11.4-19.5-30.7-28l-10.5-4.5c-30.4-12.9-50.5-29.2-50.5-63.5 0-31.4 24.1-55.6 61.6-55.6 36.8 0 56.7 15.3 69.4 35.5l-33.1 21.3c-7.2-12-19.8-19.5-35.8-19.5-16.3 0-25.6 7.5-25.6 18.9 0 12 8.1 16.5 25.3 24l10.5 4.5c31.8 13.5 51.4 32.7 51.4 66.7 0 35.2-26.4 56.7-61.9 56.7z"/></svg>',
        Java: '<svg viewBox="0 0 384 512" width="14" height="14" fill="currentColor"><path d="M277.7 460.7c-31.8 14-87.1 14.5-147.2 0-8.9-2.1-13.6-11.4-10.5-19.8 2.8-7.7 11.1-11.4 18.8-9 53 12.8 102.3 12.4 130.4 0 7.7-3.4 16.4.4 19.3 8.3 2.7 7.6-2.5 16.2-10.8 20.5zm-51.5-364.5c1.4-11.1-13.6-20-21.7-29.1-12.5-14.1-23.7-30.5-27.1-49.3-.9-5.1-6.1-8-10.8-6.1-5.6 2.3-7.5 9-6.3 14.8 5 24 19.5 44 32.7 61.5 5.5 7.3 11.1 14.5 14.6 22.9 6.2 15.1 4.5 32.5-3 46.5-5.2 9.6-12 18-18.7 26.6-12.8 16.6-25.9 33.5-30.2 54.4-1 5.1 2.8 9.9 8 10 5.4.1 10.3-3.7 11.6-9 5.3-22.1 19.6-40.4 33.1-58.1 9-11.7 18.2-23.8 24-37 8-18.2 6.5-35.3-.9-52.1-1.3-2.9-2.3-5.8-3.3-8.8v.1c-.2-.5-.4-1.1-.4-1.6l-.1-.4-.5-1.5.1-4zm-80.1 324.9c14.2 8.7 51 14 83 14 36.4 0 69.3-5.8 84.4-15 7.2-4.4 16.5-1.7 20.5 5.8 3.9 7.3 1.1 16.4-6.3 20.8-21 12.7-61 19.3-100.8 19.3-35 0-70.1-5.6-88.6-16.8-7.3-4.4-9.8-13.7-5.5-21.1 4.3-7.1 13.1-9.9 20.3-5.5zm190.6-59.5c-15.6 7.4-44.4 12-76 13.4-33.1 1.4-65.7-1.4-82-8.3-7.3-3.1-10.8-11.5-7.8-18.9 3-7.2 11.1-10.7 18.5-7.6 12 5.1 40 7.8 69.5 6.6 28.5-1.2 54.3-5.3 65.5-10.6 7.2-3.4 15.8-.1 18.9 7.3 3.1 7.2-.6 15.5-7.8 18.9zm-49.3-107.6c-7.9 14.9-19.1 29.1-30.9 44-12.7 16-25 31.6-28.7 51-1 5.3 2.8 10.2 8.1 10.5 5.6.3 10.6-3.7 12-9.2 4.4-18.5 16-33.1 28.1-48.4 10.1-12.8 20.7-26.2 26.6-41.9 6.7-17.7 5-36-3.2-51.4-4.8-8.9-10.8-17-16.7-24.9-11.2-15-22.3-30-26-48.9-1-5.3-5.9-8.8-11.2-7.8-5.3 1-8.9 6.2-7.9 11.5 4.3 21.6 16.5 38 28.6 54.1 6.5 8.7 13.1 17.5 17.2 26.9 7 16 7 31.4 1.2 44.2zm-207.2 118c21.8 10 57.6 15.4 92.4 15.4 39.5 0 74.3-6.1 89.2-13.8 7.3-3.8 16.3-1 20 6.3 3.7 7.1.8 15.9-6.3 19.6-18.6 9.6-56.7 16.4-101.4 16.4-38.3 0-76.4-5.9-102.5-17.9-7.5-3.5-10.8-12.3-7.4-19.8 3.5-7.5 12.3-10.7 19.8-7.2h-.1zm15.7-190.5c-5 13.9-3.7 29.8 2.5 44 4.5 10.3 10.3 19.6 16 28.7 10.8 17.2 20.8 33.1 22.4 51.5.6 6.3 6.3 10.9 12.6 10.2 6.1-.6 10.7-5.9 10.1-12-1.9-22-12.6-39.1-24.1-57.5-6.2-9.9-12.4-19.8-17.1-30.8-5.3-12.5-6.1-26.3-1.8-38.4 2-5.7-1-11.9-6.7-14-5.7-2.1-12 1-14 6.7v-.1z"/></svg>'
    };

    let projectsData = [];

    const buildCardHTML = (project) => {
        let typeBadgeHTML = '';
        if (project.webapp) typeBadgeHTML = `<span class="tag">${icons.webapp}</span>`;
        else if (project.terminal) typeBadgeHTML = `<span class="tag">${icons.terminal}</span>`;
        else if (project.desktopApp) typeBadgeHTML = `<span class="tag">${icons.desktopApp}</span>`;

        let langBadgeHTML = `<span class="tag lang-tag">${icons[project.language] || ''} ${project.language}</span>`;

        let linksHTML = `<a href="${project.repoLink}" class="btn-action">Source Code</a>`;
        if (project.webapp && project.demoLink) {
            linksHTML += `<a href="${project.demoLink}" class="btn-action primary">View Demo</a>`;
        }

        return `
            <article class="card glass-panel reveal-element">
                <div class="card-content-wrapper">
                    <div class="card-header">
                        <h4 class="card-title">${project.title}</h4>
                        <p class="card-desc">${project.description}</p>
                    </div>
                    <div class="card-tags">
                        ${typeBadgeHTML}
                        ${langBadgeHTML}
                    </div>
                </div>
                <div class="card-actions">
                    ${linksHTML}
                </div>
            </article>
        `;
    };

    const renderFilteredProjects = () => {
        const query = searchInput.value.toLowerCase().trim();
        const selectedLang = languageSelect.value;
        const sortMethod = sortSelect.value;

        let filtered = projectsData.filter(project => {
            const matchesSearch = project.title.toLowerCase().includes(query) || project.description.toLowerCase().includes(query);
            const matchesLang = selectedLang === "all" || project.language === selectedLang;
            return matchesSearch && matchesLang;
        });

        filtered.sort((a, b) => {
            const dateA = new Date(a.date).getTime();
            const dateB = new Date(b.date).getTime();
            return sortMethod === "newest" ? dateB - dateA : dateA - dateB;
        });

        featuredProjectsContainer.innerHTML = '';
        otherProjectsContainer.innerHTML = '';

        if (filtered.length === 0) {
            emptyState.style.display = 'flex';
            featuredSection.style.display = 'none';
            otherSection.style.display = 'none';
        } else {
            emptyState.style.display = 'none';

            let hasFeatured = false;
            let hasOther = false;

            filtered.forEach(project => {
                const cardHTML = buildCardHTML(project);
                if (project.isFeatured) {
                    featuredProjectsContainer.insertAdjacentHTML('beforeend', cardHTML);
                    hasFeatured = true;
                } else {
                    otherProjectsContainer.insertAdjacentHTML('beforeend', cardHTML);
                    hasOther = true;
                }
            });

            featuredSection.style.display = hasFeatured ? 'block' : 'none';
            otherSection.style.display = hasOther ? 'block' : 'none';

            observeElements();
        }
    };

    if (searchInput && languageSelect && sortSelect && featuredProjectsContainer && otherProjectsContainer) {
        fetch('projects.json')
            .then(response => response.json())
            .then(data => {
                projectsData = data;
                renderFilteredProjects();
            })
            .catch(error => {
                console.error("Error loading projects data.");
            });

        searchInput.addEventListener("input", renderFilteredProjects);
        languageSelect.addEventListener("change", renderFilteredProjects);
        sortSelect.addEventListener("change", renderFilteredProjects);
    }
});