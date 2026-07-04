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

    const revealElements = document.querySelectorAll(".reveal-element");
    revealElements.forEach(el => scrollObserver.observe(el));

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

    const featuredProjectsContainer = document.getElementById("featured-projects");
    const otherProjectsContainer = document.getElementById("other-projects");

    if (searchInput && languageSelect && sortSelect && featuredProjectsContainer && otherProjectsContainer) {

        const featuredCards = Array.from(featuredProjectsContainer.querySelectorAll(".card"));
        const otherCards = Array.from(otherProjectsContainer.querySelectorAll(".card"));
        const allCards = [...featuredCards, ...otherCards];

        const filterAndSortProjects = () => {
            const query = searchInput.value.toLowerCase().trim();
            const language = languageSelect.value;
            const sortMethod = sortSelect.value;

            allCards.forEach(card => {
                const title = card.getAttribute("data-title")?.toLowerCase() || "";
                const cardLang = card.getAttribute("data-language") || "";

                const matchesSearch = title.includes(query);
                const matchesLanguage = language === "all" || cardLang === language;

                if (matchesSearch && matchesLanguage) {
                    card.style.display = "flex";
                } else {
                    card.style.display = "none";
                }
            });

            const sortLogic = (a, b) => {
                const dateA = new Date(a.getAttribute("data-date") || 0).getTime();
                const dateB = new Date(b.getAttribute("data-date") || 0).getTime();
                return sortMethod === "newest" ? dateB - dateA : dateA - dateB;
            };

            const sortedFeatured = [...featuredCards].sort(sortLogic);
            sortedFeatured.forEach((card, index) => {
                card.style.order = index;
            });

            const sortedOther = [...otherCards].sort(sortLogic);
            sortedOther.forEach((card, index) => {
                card.style.order = index;
            });
        };

        searchInput.addEventListener("input", filterAndSortProjects);
        languageSelect.addEventListener("change", filterAndSortProjects);
        sortSelect.addEventListener("change", filterAndSortProjects);

        filterAndSortProjects();
    }
});