"use strict";

document.addEventListener("DOMContentLoaded", () => {
    const searchInput = document.getElementById("search-input");
    const languageFilter = document.getElementById("language-filter");
    const dateSort = document.getElementById("date-sort");

    const featuredGrid = document.getElementById("featured-grid");
    const otherGrid = document.getElementById("other-grid");

    if (!searchInput || !languageFilter || !dateSort || !featuredGrid || !otherGrid) return;

    const featuredCards = Array.from(featuredGrid.querySelectorAll(".project-card"));
    const otherCards = Array.from(otherGrid.querySelectorAll(".project-card"));
    const allCards = [...featuredCards, ...otherCards];

    const sortCards = (cards, sortOrder) => {
        return cards.sort((a, b) => {
            const dateA = new Date(a.getAttribute("data-date") || 0).getTime();
            const dateB = new Date(b.getAttribute("data-date") || 0).getTime();
            return sortOrder === "newest" ? dateB - dateA : dateA - dateB;
        });
    };

    const handleFiltering = () => {
        const searchTerm = searchInput.value?.toLowerCase().trim() || "";
        const selectedLanguage = languageFilter.value || "all";
        const sortOrder = dateSort.value || "newest";

        allCards.forEach(card => {
            const title = card.getAttribute("data-title")?.toLowerCase() || "";
            const language = card.getAttribute("data-language") || "";

            const matchesSearch = title.includes(searchTerm);
            const matchesLanguage = selectedLanguage === "all" || language === selectedLanguage;

            if (matchesSearch && matchesLanguage) {
                card.style.display = "flex";
            } else {
                card.style.display = "none";
            }
        });

        const sortedFeatured = sortCards([...featuredCards], sortOrder);
        sortedFeatured.forEach((card, index) => {
            card.style.order = index;
        });

        const sortedOther = sortCards([...otherCards], sortOrder);
        sortedOther.forEach((card, index) => {
            card.style.order = index;
        });
    };

    searchInput.addEventListener("input", handleFiltering);
    languageFilter.addEventListener("change", handleFiltering);
    dateSort.addEventListener("change", handleFiltering);

    handleFiltering();

    const typeWriterEffect = (elementId, texts, speed = 70, pause = 1500) => {
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
                delay = speed * 4;
            }

            setTimeout(type, delay);
        };

        setTimeout(type, speed * 4);
    };

    const emailPlaceholders = ["name@company.com", "hello@startup.io", "recruiter@agency.com"];
    const messagePlaceholders = ["How can we work together?", "I have a project for you...", "Let's discuss an opportunity."];

    typeWriterEffect("email", emailPlaceholders);
    typeWriterEffect("message", messagePlaceholders);
});