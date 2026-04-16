const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

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

let messages = [];
app.post('/webhook', (req, res) => {
  const data = req.body;
  const msg = {
    id: Date.now(),
    buyer: data.buyer || 'unknown',
    subject: data.subject || '',
    message: data.message || '',
    item: data.item || '',
    orderId: data.orderId || '',
    itemId: data.itemId || '',
    timestamp: new Date().toISOString(),
    read: false,
    starred: false,
    replied: false,
    memo: ''
  };
  messages.unshift(msg);
  if (messages.length > 200) messages = messages.slice(0, 200);
  res.json({ ok: true });
});

app.get('/api/messages', async (req, res) => {
  try {
    const sheetId = process.env.SHEET_ID;
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!sheetId || !apiKey) {
      return res.json({ messages });
    }
    // シート1をURLエンコード
    const sheetName = encodeURIComponent('シート1');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${sheetName}?key=${apiKey}`;
    console.log('Fetching:', url);
    const response = await fetch(url);
    const data = await response.json();
    console.log('Sheet response:', JSON.stringify(data).substring(0, 200));
    
    if (data.error) {
      console.error('Sheet error:', data.error);
      return res.json({ messages, error: data.error });
    }
    
    const rows = data.values || [];
    if (rows.length <= 1) return res.json({ messages });
    
    const headers = rows[0];
    const sheetMessages = rows.slice(1).reverse().map((row, i) => {
      const obj = {};
      headers.forEach((h, j) => { obj[h] = row[j] || ''; });
      return {
        id: rows.length - i,
        buyer: obj.buyer || 'unknown',
        subject: obj.subject || '',
        message: obj.message || '',
        item: obj.item || '',
        orderId: obj.orderId || '',
        itemId: obj.itemId || '',
        timestamp: obj.timestamp || '',
        read: false,
        starred: false,
        replied: false,
        memo: ''
      };
    });
    res.json({ messages: sheetMessages });
  } catch (e) {
    console.error('Error:', e.message);
    res.json({ messages });
  }
});

app.get('/latest', (req, res) => {
  if (messages.length > 0) {
    res.json({ message: messages[0] });
  } else {
    res.json({ message: null });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
