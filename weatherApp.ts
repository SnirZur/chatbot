import { createKafka, parseMessage } from './kafka';
import { AppResultEvent, IntentWeatherEvent, topics } from './types';

const kafka = createKafka('weather-app');
const consumer = kafka.consumer({ groupId: 'weather-app-group' });
const producer = kafka.producer();

const getWeather = async (city: string): Promise<string> => {
   const apiKey = process.env.OPENWEATHER_API_KEY;
   if (!apiKey) {
      return 'חסר מפתח API למזג אוויר. נא להגדיר OPENWEATHER_API_KEY.';
   }

   const trimmed = city.trim();
   if (!trimmed) return 'לא הצלחתי להבין לאיזו עיר אתה מתכוון.';

   try {
      const url = new URL('https://api.openweathermap.org/data/2.5/weather');
      url.searchParams.set('q', trimmed);
      url.searchParams.set('appid', apiKey);
      url.searchParams.set('units', 'metric');
      url.searchParams.set('lang', 'he');

      const response = await fetch(url);
      if (!response.ok) {
         throw new Error('Weather API request failed');
      }

      const data = await response.json();
      const temp = Number(data?.main?.temp);
      const description = data?.weather?.[0]?.description;

      if (!Number.isFinite(temp) || typeof description !== 'string') {
         throw new Error('Invalid weather data');
      }

      return `${Math.round(temp)} מעלות, ${description}`;
   } catch (error) {
      console.error(error);
      return 'לא הצלחתי להביא את מזג האוויר כרגע, נסה שוב מאוחר יותר.';
   }
};

await producer.connect();
await consumer.connect();
await consumer.subscribe({ topic: topics.intentWeather, fromBeginning: true });

consumer.run({
   eachMessage: async ({ message }) => {
      const parsed = parseMessage<IntentWeatherEvent>(message);
      if (!parsed) return;

      const result = await getWeather(parsed.value.city);
      const payload: AppResultEvent = { type: 'weather', result };

      await producer.send({
         topic: topics.appResults,
         messages: [{ key: parsed.key, value: JSON.stringify(payload) }],
      });
   },
});
