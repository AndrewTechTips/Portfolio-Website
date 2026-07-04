const searchInput = document.getElementById('search-input');
const languageFilter = document.getElementById('language-filter');
const dateSort = document.getElementById('date-sort');
const projectGrid = document.getElementById('project-grid');
const projectCards = Array.from(document.querySelectorAll('.project-card'));

function updateGrid() {
    const searchTerm = searchInput.value.toLowerCase().trim();
    const selectedLanguage = languageFilter.value;
    const sortOrder = dateSort.value;

    const filteredCards = projectCards.filter(card => {
        const title = card.getAttribute('data-title').toLowerCase();
        const language = card.getAttribute('data-language');

        const matchesSearch = title.includes(searchTerm);
        const matchesLanguage = selectedLanguage === 'all' || language === selectedLanguage;

        return matchesSearch && matchesLanguage;
    });

    filteredCards.sort((a, b) => {
        const dateA = new Date(a.getAttribute('data-date')).getTime();
        const dateB = new Date(b.getAttribute('data-date')).getTime();

        if (sortOrder === 'newest') {
            return dateB - dateA;
        } else {
            return dateA - dateB;
        }
    });

    projectGrid.innerHTML = '';

    filteredCards.forEach(card => {
        projectGrid.appendChild(card);
    });
}

searchInput.addEventListener('input', updateGrid);
languageFilter.addEventListener('change', updateGrid);
dateSort.addEventListener('change', updateGrid);

updateGrid();