# 🎵 YouTube Scraper & MP3 Downloader

A high-performance, premium web application built with **Next.js** and **Playwright** that allows you to scrape YouTube videos or entire playlists and convert them into high-quality MP3 files effortlessly.

![Next.js](https://img.shields.io/badge/Next.js-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)

---

## ✨ Features

- 🔗 **Multiple URL Input**: Paste multiple YouTube links (videos or playlists) at once.
- 📂 **Custom Destination**: Select any local folder to save your downloaded MP3s.
- 🎼 **Playlist Support**: Automatically extract every video from a playlist link.
- ⚡ **Live Progress**: Real-time status updates for scraping and conversion via NDJSON streams.
- 🎨 **Premium UI**: A sleek, modern dark-mode interface with smooth animations and interactive feedback.
- 🛡️ **Robust Extraction**: Advanced Playwright-based scraping that handles dynamic content and auto-scrolls playlists.

---

## 🛠️ Tech Stack

- **Frontend**: Next.js 15 (App Router), React 19, Vanilla CSS.
- **Backend**: Next.js API Routes (Node.js runtime).
- **Automation**: Playwright (Chromium) for link extraction and conversion automation.
- **Storage**: `fs-extra` for local file management and metadata storage.

---

## 🚀 Getting Started

### Prerequisites

- **Node.js**: v18.x or higher.
- **Google Chrome**: Installed on your local machine (the app uses your local Chrome installation for better compatibility).

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-username/yt-playlist-download.git
   cd yt-playlist-download
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Install Playwright Browsers**:
   ```bash
   npx playwright install chromium
   ```

### Running the App

Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 📖 How to Use

1. **Set Destination**: Click the **Browse** button to select a folder where you want to save the MP3 files.
2. **Add Links**: Paste your YouTube URL(s). Click the **+** icon to add more input fields if you have multiple links.
3. **Choose Mode**:
   - **Single Video**: Select this if your links are individual videos.
   - **Playlist**: Select this if your links are YouTube playlists.
4. **Engage Scraper**: Click the button to start the extraction process.
5. **Download**: Once scraping is complete, review the list of found videos and click **Download All** to start the conversion process.

---

## 📁 Project Structure

- `src/app/page.tsx`: The main UI and frontend logic.
- `src/app/api/scrape/route.ts`: API endpoint that spawns the scraper process.
- `src/app/api/convert/route.ts`: API endpoint that automates the conversion and download.
- `scraper/index.ts`: The core Playwright script for YouTube metadata extraction.
- `data/`: Temporary storage for scraped metadata (JSON).

---

## 🤝 Contributing

Contributions are welcome! If you have a feature request, bug report, or a pull request, please feel free to open an issue or submit a PR.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request


## ⚠️ Disclaimer

This tool is for **educational purposes only**. Please ensure you have the right to download content from YouTube and respect the Terms of Service of the platform. The authors are not responsible for any misuse of this software.

---


Built with ❤️ by Bhuvaneshwari G and special thanks to **Saksham Agarwal** ([sakshamagarwalm2](https://github.com/sakshamagarwalm2)) 