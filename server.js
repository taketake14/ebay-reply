const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();

app.use(express.json());

// index.htmlをルートで直接配信
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Claude APIへのプロキシ
app.post('/api/claude', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Zapierからのwebhook受信
app.post('/webhook', (req, res) => {
  const data = req.body;
  latestMessage = data;
  res.json({ ok: true });
});

// クライアントが新着メッセージをポーリングで取得
let latestMessage = null;
app.get('/latest', (req, res) => {
  if (latestMessage) {
    const msg = latestMessage;
    latestMessage = null;
    res.json({ message: msg });
  } else {
    res.json({ message: null });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
