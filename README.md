# GroupCallWeb — 50-Person React.js Group Calling Web App

Enterprise-grade WebRTC Group Audio & Video calling frontend built with **React.js**, **TypeScript**, and **Vite**, with a professional light theme UI/UX.

---

## ✨ Features

- **Up to 50 Participants**: Supports paginated grid layouts with natural navigation arrows and bottom page dots.
- **Video & Voice Rooms**:
  - **Video Meeting Mode**: Responsive grid (1 to 6 video feeds per page on desktop, adaptive for tablets and mobile).
  - **Voice Room (Audio) Mode**: Clubhouse / Twitter Spaces style cards with active speaking pulse ripples, full participant names, and vertical spacing.
- **Screen Sharing**: Present screens or windows directly to all peers.
- **Real-Time Active Speaker Visualizer**: Web Audio API analyser ring highlights speaking participants in emerald green.
- **Hand Raising**: Dedicated hand raise system with alert banner.
- **Searchable 50-Person Drawer**: Inspect and search through all 50 participants by name and status.
- **Built-In 50-Person Stress Simulator**:
  - Test the entire 50-person experience on one machine without external infrastructure!
  - Tap **🧪 Test (1/50)** → **🚀 Fill to 50 Users** to inject 50 realistic simulated participants with speaking animations and hand raises.
- **Cross-Platform Compatibility**: Uses the same signaling protocol as the `GroupCallTest` React Native mobile app! You can call between Web and Mobile in the same room.

---

## 🚀 Quick Start

### 1. Start the Signaling Server
```bash
npm run server
```
Server runs on `http://localhost:3000`.

### 2. Start the React Frontend
In another terminal:
```bash
npm run dev
```
Open `http://localhost:5173` in your browser.

### 3. Production Build
```bash
npm run build
npm run preview
```
Production assets are generated in `dist/`.
