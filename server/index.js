// Local server: the API plus the built React app on one port.
// On Vercel, api/index.js is used instead and the CDN serves dist/.
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import app from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const distDir = path.join(__dirname, "..", "dist");

const server = express();

server.use(app);
server.use(express.static(distDir));

server.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

server.listen(PORT, () => {
  console.log(`Image Converter Pro running on http://localhost:${PORT}`);
});
