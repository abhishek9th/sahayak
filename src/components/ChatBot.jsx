import React, { useEffect, useRef, useState } from 'react';
import { Mic, Send, ChevronDown, Volume2, Volume1, Square, Loader2 } from 'lucide-react';
import { processNaturalLanguageQuery } from '../services/aiService';
import { readTextAloud, stopTextAloud } from '../services/audioService';
import { cleanupRecording, startBrowserFallback, startGroqRecording, stopGroqRecording } from '../services/voiceService';
import { useI18n } from '../i18n';

// Map the signed-in user's SAVED profile (Supabase `profiles` row, snake_case)
// into the camelCase shape the chatbot/backend already use for extractedData,
// so the assistant knows what the app already knows instead of re-asking.
function seedProfileFrom(userProfile) {
  if (!userProfile) return {};
  const seeded = {
    state: userProfile.state || undefined,
    annualFamilyIncome: userProfile.annual_income ?? undefined,
    gender: userProfile.gender || undefined,
    socialCategory: userProfile.social_category || undefined,
    educationLevel: userProfile.education_level || undefined,
  };
  return Object.fromEntries(Object.entries(seeded).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

export default function ChatBot({ onVoiceProfileReady, userProfile }) {
  const { tr, lang: currentLang } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [voiceState, setVoiceState] = useState('idle');
  // Seeded from the user's saved profile (if signed in) so the assistant
  // already knows their state/income/category etc. and doesn't re-ask.
  const [profile, setProfile] = useState(() => seedProfileFrom(userProfile));

  // Re-seed if the saved profile loads/changes after mount (e.g. right after
  // sign-in) — but never clobber facts the user has already told THIS chat.
  useEffect(() => {
    const seeded = seedProfileFrom(userProfile);
    if (Object.keys(seeded).length) {
      setProfile((prev) => ({ ...seeded, ...prev }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userProfile]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const fallbackRef = useRef(null);
  const messagesEndRef = useRef(null);
  const hasSpokenGreetingRef = useRef(false);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Let any part of the app (e.g. footer "Helpdesk"/"FAQ"/"Feedback" links) open
  // the assistant by dispatching a window event.
  useEffect(() => {
    const open = () => setIsOpen(true);
    window.addEventListener('ss:open-chat', open);
    return () => window.removeEventListener('ss:open-chat', open);
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Speak function
  const speak = (text) => {
    if (!text) return;
    setIsSpeaking(true);
    const started = readTextAloud(text, currentLang, () => {
      setIsSpeaking(false);
    });
    if (!started) setIsSpeaking(false); // no voice available for this language — text only
  };

  // Stop speaking
  const stopSpeaking = () => {
    stopTextAloud();
    setIsSpeaking(false);
  };

  // Initialize chat — and keep the greeting itself live-translated if the
  // user switches language before typing anything (it was previously frozen
  // in whatever language was active the moment the chat first opened).
  //
  // For languages other than English/Hindi, tr() returns the Hindi text until the
  // machine translation arrives a moment later. Showing/speaking that fallback
  // made the bot greet a Tamil user in Hindi, so the greeting is held back until
  // the real translation is available (with a short timeout in case it never is).
  const GREETING_EN = "Hello! I'm SchemeSahayak. What kind of government scheme are you looking for?";
  const GREETING_HI = 'नमस्ते! मैं SchemeSahayak हूँ। आपको किस प्रकार की सरकारी योजना की जानकारी चाहिए?';
  const greeting = tr(GREETING_EN, GREETING_HI);
  const greetingPending = currentLang !== 'en' && currentLang !== 'hi' && greeting === GREETING_HI;
  const [greetingTimedOut, setGreetingTimedOut] = useState(false);

  useEffect(() => {
    if (!isOpen || !greetingPending) { setGreetingTimedOut(false); return undefined; }
    const timer = setTimeout(() => setGreetingTimedOut(true), 6000);
    return () => clearTimeout(timer);
  }, [isOpen, greetingPending, currentLang]);

  useEffect(() => {
    if (!isOpen) { hasSpokenGreetingRef.current = false; return undefined; }
    if (!greetingPending || greetingTimedOut) {
      // The "Speak bot messages" effect below reads this message aloud exactly once.
      setMessages((prev) => (prev.length === 0 || (prev.length === 1 && prev[0].id === 1))
        ? [{ id: 1, type: 'bot', text: greeting }]
        : prev);
    }
    return () => { stopTextAloud(); cleanupRecording(); fallbackRef.current?.abort?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, currentLang, greeting, greetingPending, greetingTimedOut]);

  // Speak bot messages
  useEffect(() => {
    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.type === 'bot') {
        speak(lastMessage.text);
      }
    }
  }, [messages]);

  const toggleRecording = async () => {
    if (voiceState === 'recording') {
      setVoiceState('transcribing');
      try {
        const text = await stopGroqRecording(currentLang);
        setInputText(text);
        setVoiceState('idle');
      } catch (error) {
        setVoiceState('error');
        const errorMsg = tr('Could not understand audio. Please try again.', 'आवाज़ समझने में समस्या। कृपया दोबारा कोशिश करें।');
        setMessages(prev => [...prev, { id: Date.now(), type: 'bot', text: errorMsg }]);
      }
      return;
    }

    if (!navigator.mediaDevices || !window.MediaRecorder) {
      setMessages(prev => [...prev, { 
        id: Date.now(), 
        type: 'bot', 
        text: tr('Microphone unavailable. Please type instead.', 'माइक्रोफोन उपलब्ध नहीं। कृपया टाइप करके बताएं।')
      }]);
      return;
    }

    try {
      setVoiceState('requesting_permission');
      await startGroqRecording();
      setVoiceState('recording');
    } catch (error) {
      setVoiceState('error');
      const errorMsg = error?.name === 'NotAllowedError'
        ? tr('Microphone permission denied.', 'माइक्रोफोन की अनुमति नहीं मिली।')
        : tr('Microphone not available.', 'माइक्रोफोन उपलब्ध नहीं है।');
      setMessages(prev => [...prev, { id: Date.now(), type: 'bot', text: errorMsg }]);
    }
  };

  const sendMessage = async () => {
    if (!inputText.trim()) return;

    // Add user message
    const userMessage = { id: Date.now(), type: 'user', text: inputText };
    setMessages(prev => [...prev, userMessage]);
    setInputText('');
    setIsProcessing(true);

    try {
      const result = await processNaturalLanguageQuery(inputText, profile, currentLang);
      
      // Update profile
      const extracted = result.extractedData || {};
      const newProfileData = Object.fromEntries(
        Object.entries(extracted).filter(([, value]) => value !== null && value !== '')
      );
      const updatedProfile = { ...profile, ...newProfileData };
      setProfile(updatedProfile);

      // Add bot response — prefer the conversational answer to the user's question.
      const botReply = result.answer || result.nextQuestion || tr('Please provide more details.', 'अपनी जानकारी दें।');

      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        type: 'bot',
        text: botReply
      }]);

      // If enough is known, offer to show matching schemes after the user has had
      // a moment to read the answer.
      if (result.shouldFilterSchemes) {
        setTimeout(() => {
          onVoiceProfileReady?.(updatedProfile);
        }, 2600);
      }
    } catch (error) {
      console.error('Chat error:', error);
      const errorMsg = tr('Error processing your message. Please try again.', 'जानकारी समझने में समस्या। कृपया दोबारा कोशिश करें।');
      setMessages(prev => [...prev, { id: Date.now() + 2, type: 'bot', text: errorMsg }]);
    } finally {
      setIsProcessing(false);
    }
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full bg-gradient-to-br from-[#0B75C9] to-[#075C9C] text-white shadow-xl hover:shadow-2xl transition-all hover:scale-110 flex items-center justify-center"
        aria-label="Open chat"
      >
        💬
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-40 w-96 max-w-full bg-white rounded-2xl shadow-2xl border-2 border-[#BFDBFE] overflow-hidden flex flex-col h-[600px] max-h-[80vh]">
      {/* Header */}
      <div className="bg-gradient-to-r from-[#0B75C9] to-[#075C9C] text-white p-4 flex items-center justify-between">
        <div>
          <h3 className="font-black text-lg">{tr('SchemeSahayak Help', 'SchemeSahayak सहायता')}</h3>
          <p className="text-xs text-blue-100">{tr('Ask by voice or text', 'बोलकर या लिखकर पूछें')}</p>
        </div>
        <button 
          onClick={() => setIsOpen(false)} 
          className="text-white hover:bg-white/20 p-1 rounded-lg transition"
          aria-label="Close"
        >
          <ChevronDown className="w-5 h-5" />
        </button>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50">
        {messages.map((msg) => (
          <div 
            key={msg.id} 
            className={`flex gap-2 ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm font-semibold leading-relaxed ${
                msg.type === 'user'
                  ? 'bg-[#0B75C9] text-white rounded-br-none'
                  : 'bg-white border-2 border-[#BFDBFE] text-slate-800 rounded-bl-none'
              }`}
            >
              {msg.text}
            </div>
            {msg.type === 'bot' && (
              <button
                onClick={() => isSpeaking ? stopSpeaking() : speak(msg.text)}
                className={`p-1 transition self-center ${
                  isSpeaking && msg.id === messages[messages.length - 1].id
                    ? 'text-red-500 hover:text-red-700 animate-pulse'
                    : 'text-[#0B75C9] hover:text-[#075C9C]'
                }`}
                title={isSpeaking ? tr('Stop', 'सुनना बंद करें') : tr('Listen again', 'फिर से सुनें')}
              >
                {isSpeaking && msg.id === messages[messages.length - 1].id ? (
                  <Volume1 className="w-4 h-4" />
                ) : (
                  <Volume2 className="w-4 h-4" />
                )}
              </button>
            )}
          </div>
        ))}
        {isProcessing && (
          <div className="flex justify-start">
            <div className="bg-white border-2 border-[#BFDBFE] text-slate-600 rounded-2xl rounded-bl-none px-4 py-2.5">
              <div className="flex gap-1.5">
                <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" />
                <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce delay-100" />
                <div className="w-2 h-2 bg-slate-400 rounded-full animate-bounce delay-200" />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area — one adaptive button in place of the arrow: mic when the
          box is empty, send arrow once there's text to send (typed or from a
          finished voice transcription), and a stop icon while recording. */}
      <div className="bg-white border-t-2 border-[#BFDBFE] p-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && !isProcessing && inputText.trim() && sendMessage()}
            placeholder={voiceState === 'recording'
              ? tr('Listening…', 'सुन रहे हैं…')
              : tr('Type message...', 'संदेश भेजें...')}
            className="flex-1 px-4 py-2.5 border-2 border-[#BFDBFE] rounded-xl focus:outline-none focus:border-[#0B75C9] focus:ring-2 focus:ring-[#60A5FA] font-semibold text-slate-800"
            disabled={isProcessing || voiceState === 'recording' || voiceState === 'transcribing'}
          />
          {(() => {
            if (voiceState === 'transcribing') {
              return (
                <button disabled className="bg-[#0B75C9] text-white p-2.5 rounded-xl opacity-60" aria-label={tr('Transcribing…', 'लिखा जा रहा है…')}>
                  <Loader2 className="w-5 h-5 animate-spin" />
                </button>
              );
            }
            if (voiceState === 'recording') {
              return (
                <button
                  onClick={toggleRecording}
                  className="bg-red-600 hover:bg-red-700 text-white p-2.5 rounded-xl transition animate-pulse"
                  aria-label={tr('Stop recording', 'रिकॉर्डिंग रोकें')}
                  title={tr('Recording… click to stop', 'रिकॉर्डिंग जारी है… रोकने के लिए क्लिक करें')}
                >
                  <Square className="w-5 h-5" fill="currentColor" />
                </button>
              );
            }
            if (inputText.trim()) {
              return (
                <button
                  onClick={sendMessage}
                  disabled={isProcessing}
                  className="bg-[#0B75C9] hover:bg-[#075C9C] text-white p-2.5 rounded-xl transition disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label={tr('Send message', 'संदेश भेजें')}
                >
                  <Send className="w-5 h-5" />
                </button>
              );
            }
            return (
              <button
                onClick={toggleRecording}
                disabled={isProcessing || voiceState === 'requesting_permission'}
                className="bg-green-600 hover:bg-green-700 text-white p-2.5 rounded-xl transition disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label={tr('Speak', 'माइक से बोलें')}
                title={tr('Speak', 'माइक से बोलें')}
              >
                <Mic className="w-5 h-5" />
              </button>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
