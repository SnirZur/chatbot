import type { Request, Response } from 'express';
import path from 'path';
import z from 'zod';
import { isKafkaReady, sendReset, sendUserInput } from '../kafka.gateway';

// Implementation detail
const chatSchema = z.object({
   prompt: z
      .string()
      .trim()
      .min(1, 'Prompt is required.')
      .max(1000, 'Prompt is too long (max 1000 characters'),
   conversationId: z.string().trim().min(1),
});

// Public interface
export const chatController = {
   async getKafkaHealth(_req: Request, res: Response) {
      res.setHeader('Cache-Control', 'no-store');
      const ready = await isKafkaReady();
      res.json({ ready });
   },
   async getHistoryStatus(req: Request, res: Response) {
      try {
         const conversationId = String(req.query.conversationId ?? '').trim();
         const historyPath = path.resolve(
            import.meta.dir,
            '..',
            '..',
            '..',
            'history.json'
         );
         const file = Bun.file(historyPath);
         if (!conversationId || !(await file.exists())) {
            res.json({ hasHistory: false, message: '' });
            return;
         }

         const data = await file.text();
         const parsed = JSON.parse(data) as Record<string, unknown>;
         const history = parsed[conversationId];
         const hasHistory = Array.isArray(history) && history.length > 0;
         res.json({
            hasHistory,
            message: hasHistory
               ? 'ברוך שובך! טענתי את היסטוריית השיחה הקודמת.'
               : '',
         });
      } catch (error) {
         console.error(error);
         res.json({ hasHistory: false, message: '' });
      }
   },
   async sendMessage(req: Request, res: Response) {
      const parseResult = chatSchema.safeParse(req.body);
      if (!parseResult.success) {
         res.status(400).json(parseResult.error.format());
         return;
      }

      try {
         const { prompt, conversationId } = req.body;
         if (prompt.trim() === '/reset') {
            await sendReset(conversationId);
            res.json({ message: 'היסטוריית השיחה אופסה. נתחיל שיחה חדשה.' });
            return;
         }

         try {
            const response = await sendUserInput(conversationId, prompt);
            res.json({ message: response.message });
         } catch (error) {
            console.error(error);
            res.status(503).json({
               message: 'יש עיכוב במערכת התשובות כרגע. נסה שוב בעוד כמה שניות.',
            });
         }
      } catch (error) {
         console.error(error);
         res.status(500).json({ error: 'Failed to generate a response.' });
      }
   },
};
