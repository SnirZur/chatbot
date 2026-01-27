import type { Request, Response } from 'express';
import express from 'express';
import { chatController } from './controllers/chat.controller';
import { reviewController } from './controllers/review.controller';

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

router.get('/api/products/:id/reviews', reviewController.getReviews);
router.post(
   '/api/products/:id/reviews/summarize',
   reviewController.summarizeReviews
);

export default router;
