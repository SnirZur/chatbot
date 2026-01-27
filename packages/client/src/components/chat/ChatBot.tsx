import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import ChatInput, { type ChatFormData } from './ChatInput';
import type { Message } from './ChatMessages';
import ChatMessages from './ChatMessages';
import TypingIndicator from './TypingIndicator';
import popSound from '@/assets/sounds/pop.mp3';
import notificationSound from '@/assets/sounds/notification.mp3';

const popAudio = new Audio(popSound);
popAudio.volume = 0.2;

const notificationAudio = new Audio(notificationSound);
notificationAudio.volume = 0.2;

type ChatResponse = {
   message: string;
};

type HistoryStatusResponse = {
   hasHistory: boolean;
   message: string;
};

const ChatBot = () => {
   const [messages, setMessages] = useState<Message[]>([]);
   const [isBotTyping, setIsBotTyping] = useState(false);
   const [error, setError] = useState('');
   const [isReady, setIsReady] = useState(false);
   const conversationId = useRef('');
   const didPrompt = useRef(false);

   useEffect(() => {
      if (didPrompt.current) return;
      didPrompt.current = true;
      let inputId = '';
      while (!inputId) {
         inputId = window.prompt('Enter user id:')?.trim() ?? '';
      }
      conversationId.current = inputId;
   }, []);

   useEffect(() => {
      let isActive = true;

      const loadHistoryStatus = async () => {
         try {
            const { data } = await axios.get<HistoryStatusResponse>(
               '/api/chat/history',
               {
                  params: { conversationId: conversationId.current },
               }
            );
            if (isActive && data.hasHistory && data.message) {
               setMessages([{ content: data.message, role: 'bot' }]);
            }
         } catch (error) {
            console.error(error);
         }
      };

      loadHistoryStatus();
      return () => {
         isActive = false;
      };
   }, []);

   useEffect(() => {
      let isActive = true;
      let intervalId: number | undefined;

      const checkReady = async () => {
         try {
            const { data } = await axios.get<{ ready: boolean }>(
               '/api/kafka/health'
            );
            if (!isActive) return;
            if (data.ready) {
               setIsReady(true);
               if (intervalId) window.clearInterval(intervalId);
            }
         } catch (error) {
            if (!isActive) return;
            setIsReady(false);
         }
      };

      checkReady();
      intervalId = window.setInterval(checkReady, 2000);

      return () => {
         isActive = false;
         if (intervalId) window.clearInterval(intervalId);
      };
   }, []);

   const onSubmit = async ({ prompt }: ChatFormData) => {
      try {
         setMessages((prev) => [...prev, { content: prompt, role: 'user' }]);
         setIsBotTyping(true);
         setError('');
         popAudio.play();

         const { data } = await axios.post<ChatResponse>('/api/chat', {
            prompt,
            conversationId: conversationId.current,
         });
         setMessages((prev) => [
            ...prev,
            { content: data.message, role: 'bot' },
         ]);
         notificationAudio.play();
      } catch (error) {
         console.error(error);
         setError('Something went wrong, try again!');
      } finally {
         setIsBotTyping(false);
      }
   };

   return (
      <div className="flex flex-col h-full">
         <div className="flex flex-col flex-1 gap-3 mb-10 overflow-y-auto">
            <ChatMessages messages={messages} />
            {!isReady && (
               <p className="text-sm text-gray-500">
                  ממתין להתחברות לשירותים...
               </p>
            )}
            {isBotTyping && <TypingIndicator />}
            {error && <p className="text-red-500">{error}</p>}
         </div>
         <ChatInput onSubmit={onSubmit} disabled={!isReady} />
      </div>
   );
};

export default ChatBot;
