import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import router from './routes';

dotenv.config({
   path: path.resolve(import.meta.dir, '..', '..', '.env'),
});

const app = express();
app.use(express.json());
app.use(router);

const port = process.env.PORT || 3000;

app.listen(port, () => {
   console.log(`Server is running on http://localhost:${port}`);
});
