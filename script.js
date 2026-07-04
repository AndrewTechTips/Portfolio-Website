"use strict";

document.addEventListener("DOMContentLoaded", () => {

    const themeSwitcher = document.getElementById("theme-switcher");
    const rootElement = document.documentElement;

    const applyTheme = (themeName) => {
        rootElement.setAttribute("data-theme", themeName);
        localStorage.setItem("portfolio-theme", themeName);
    };

    const determineInitialTheme = () => {
        const savedTheme = localStorage.getItem("portfolio-theme");
        if (savedTheme) {
            applyTheme(savedTheme);
        } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
            applyTheme("light");
        } else {
            applyTheme("dark");
        }
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
        rootMargin: "0px 0px -80px 0px",
        threshold: 0.1
    };

    const scrollObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add("active");
                observer.unobserve(entry.target);
            }
        });
    }, scrollObserverOptions);

    const revealElements = document.querySelectorAll(".reveal-element");
    revealElements.forEach(el => scrollObserver.observe(el));

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