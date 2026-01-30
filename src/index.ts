import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// X Webhook endpoint
app.post('/webhooks/x', (req, res) => {
  console.log('Webhook received:', req.body);
  
  // TODO: Implement webhook handler
  
  res.status(200).json({ status: 'processing' });
});

app.listen(PORT, () => {
  console.log(`Bot server running on port ${PORT}`);
});
