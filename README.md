<div align="center">

  <h1>🌐 Personal Portfolio</h1>

  <p>
    A fully responsive, multi-section <strong>developer portfolio</strong> built with Vanilla HTML, CSS, and JavaScript.<br />
    Projects are loaded dynamically from a JSON file — dark/light theme, live search, filters, and a working contact form included.
  </p>

  <p>
    <img src="https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white" alt="HTML5" />
    <img src="https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white" alt="CSS3" />
    <img src="https://img.shields.io/badge/JavaScript-Vanilla-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript" />
    <img src="https://img.shields.io/badge/No%20Framework-✓-brightgreen?style=for-the-badge" alt="No Framework" />
  </p>

  <h3>
    <a href="https://andrewtechtips.github.io/portfolio/">🔗 OPEN PORTFOLIO</a>
  </h3>

</div>

<br />

---

## ✨ Features

* **🌙 Dark / Light Mode:** Theme toggle with smooth icon swap — preference persists across the session.
* **📦 JSON-Driven Projects:** All 26 projects are loaded from `projects.json` at runtime — adding a new project means adding one JSON object, nothing else.
* **🔍 Live Search + Filters:** Filter by language (Python, JavaScript, HTML/CSS, Java) and sort by newest or oldest — all client-side, instant feedback.
* **⭐ Featured / Other Split:** Projects are automatically separated into "Featured Work" and "Other Projects" sections based on the `isFeatured` flag.
* **➕ Show More:** Other projects are paginated with a "Show More" button — the page doesn't feel overwhelming on load.
* **📬 Contact Form:** Powered by [FormSubmit](https://formsubmit.co) — no backend needed, emails arrive directly in the inbox.
* **✨ Scroll Animations:** Sections fade in with an `IntersectionObserver` as the user scrolls down.

---

## 🧠 Under the Hood

### JSON-Driven Project Cards
Projects are fetched from `projects.json` and rendered entirely in JavaScript — the HTML never needs to be touched to update the portfolio:

```javascript
// Each project object drives the entire card render
{
  "title": "BattleShip",
  "language": "JavaScript",
  "isFeatured": true,
  "webapp": true,
  "terminal": false,
  "desktopApp": false,
  "repoLink": "https://github.com/...",
  "demoLink": "https://...",
  "date": "2026-04-10"
}
```

### Live Search & Filter
Search and filter work together on the same dataset — every keystroke or dropdown change rerenders only the matching cards:

```javascript
const filtered = projects.filter(p =>
    p.title.toLowerCase().includes(query) ||
    p.description.toLowerCase().includes(query)
).filter(p =>
    language === "all" || p.language === language
);
```

### Scroll Reveal with IntersectionObserver
No animation library needed — elements with `.reveal-element` fade in natively as they enter the viewport:

```javascript
const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) entry.target.classList.add("visible");
    });
}, { threshold: 0.1 });
```

---

## 📁 Project Structure

```
Portfolio/
├── assets/
│   └── profile.jpeg       # Profile photo
├── index.html             # Full single-page HTML structure
├── style.css              # All styles — dark/light theme, glassmorphism, responsive
├── script.js              # Project rendering, search, filters, theme toggle, animations
├── projects.json          # All project data — single source of truth
└── README.md
```

---

## 🚀 Getting Started

1. **Clone the repository:**
    ```bash
    git clone https://github.com/AndrewTechTips/Portfolio.git
    cd Portfolio
    ```

2. **Open in browser:**
    ```bash
    # No build step needed — open directly
    open index.html
    ```

3. **Add a new project** — just append an object to `projects.json`:
    ```json
    {
      "title": "My New Project",
      "description": "What it does.",
      "language": "Python",
      "isFeatured": false,
      "webapp": true,
      "terminal": false,
      "desktopApp": false,
      "repoLink": "https://github.com/...",
      "demoLink": null,
      "date": "2026-07-04"
    }
    ```

---

## 📬 Contact

* **LinkedIn:** [Andrei Condrea](https://www.linkedin.com/in/andrei-condrea-b32148346)
* **Email:** condrea.andrey777@gmail.com

<p align="center">
  <i>"Built with focus and precision." ⚡</i>
</p>