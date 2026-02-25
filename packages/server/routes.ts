import type { Request, Response } from 'express';
import express from 'express';
import { chatController } from './controllers/chat.controller';

const router = express.Router();

router.get('/', (req: Request, res: Response) => {
   res.send('Hello World!');
});

router.get('/api/hello', (req: Request, res: Response) => {
   res.json({ message: 'Hello World!' });
});

router.get('/api/kafka/health', chatController.getKafkaHealth);
router.get('/api/chat/history', chatController.getHistoryStatus);
router.post('/api/chat', chatController.sendMessage);

if (process.env.ENABLE_REVIEWS === 'true') {
   const { reviewController } = await import('./controllers/review.controller');
   router.get('/api/products/:id/reviews', reviewController.getReviews);
   router.post(
      '/api/products/:id/reviews/summarize',
      reviewController.summarizeReviews
   );
} else {
   router.get('/api/products/:id/reviews', (_req, res) => {
      res.status(503).json({ error: 'Review routes disabled.' });
   });
   router.post('/api/products/:id/reviews/summarize', (_req, res) => {
      res.status(503).json({ error: 'Review routes disabled.' });
   });
}

export default router;
