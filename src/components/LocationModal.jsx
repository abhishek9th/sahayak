import React, { useEffect, useState } from 'react';
import { Navigation, Search, Building, ShieldCheck, ArrowRight, X } from 'lucide-react';
import { detectUserLocation, getLocationPermission, INDIAN_STATES } from '../services/locationService';
import { useI18n } from '../i18n';

/* Decorative, stylised India silhouette for the left brand panel (not a precise
   map — purely illustrative), with a few glowing location pins. */
function IndiaGraphic() {
  return (
    <svg viewBox="0 0 240 260" className="w-full h-full" aria-hidden="true">
      <defs>
        <linearGradient id="indiaFill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.20" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.06" />
        </linearGradient>
      </defs>
      <path
        d="M62 42 C 80 30, 104 28, 122 34 C 140 40, 150 52, 150 60
           C 158 66, 166 82, 160 96 C 154 108, 150 118, 152 130
           C 146 152, 132 172, 118 194 C 110 210, 104 226, 100 240
           C 94 222, 86 200, 78 178 C 68 158, 58 138, 50 116
           C 44 100, 42 84, 46 68 C 50 54, 54 46, 62 42 Z"
        fill="url(#indiaFill)"
        stroke="#ffffff"
        strokeOpacity="0.35"
        strokeWidth="1.5"
      />
      {[[92, 78], [128, 108], [104, 150], [86, 118]].map(([cx, cy], i) => (
        <g key={i}>
          <circle cx={cx} cy={cy} r="10" fill="#F59E0B" opacity="0.18" />
          <circle cx={cx} cy={cy} r="4.5" fill="#F59E0B" />
          <circle cx={cx} cy={cy} r="2" fill="#fff" />
        </g>
      ))}
    </svg>
  );
}

export default function LocationModal({ onLocationGranted, onLocationDenied }) {
  const { tr } = useI18n();
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const [showManualDropdown, setShowManualDropdown] = useState(false);
  const [searchStateQuery, setSearchStateQuery] = useState('');

  const handleGrantPermission = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const locData = await detectUserLocation();
      onLocationGranted(locData);
    } catch (err) {
      console.warn('Location permission denied or failed:', err);
      setErrorMsg(tr('Could not detect location. Please select your state manually below.', 'स्थान का पता नहीं चल सका। कृपया नीचे से अपना राज्य चुनें।'));
      setShowManualDropdown(true);
    } finally {
      setLoading(false);
    }
  };

  // If the browser already has location permission, detect straight away instead
  // of making the user click again on every visit/session.
  useEffect(() => {
    let active = true;
    getLocationPermission().then((p) => { if (active && p === 'granted') handleGrantPermission(); });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Picking a state applies it straight away — no separate confirm step.
  const handleSelectState = (matchedState) => {
    onLocationGranted({ state: matchedState.name, state_hi: matchedState.name_hi, suggestedLang: matchedState.lang });
  };

  const filteredStates = INDIAN_STATES.filter(
    (s) => s.name.toLowerCase().includes(searchStateQuery.toLowerCase()) || s.name_hi.includes(searchStateQuery)
  );

  return (
    <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-sm z-[80] flex items-center justify-center p-4">
      <div className="bg-white rounded-lg w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col md:flex-row animate-in fade-in zoom-in duration-200">

        {/* ---------- LEFT BRAND PANEL ---------- */}
        <div
          className="hidden md:flex md:w-[44%] p-8 flex-col justify-between text-white relative overflow-hidden"
          style={{ background: 'linear-gradient(160deg, #0b2d63 0%, #123f86 55%, #0e326e 100%)' }}
        >
          <div className="relative z-10">
            <div className="flex items-center gap-2.5">
              <svg viewBox="0 0 82 70" className="w-9 h-9 shrink-0" aria-hidden="true">
                <circle cx="27" cy="12" r="10" fill="#F97316" />
                <circle cx="11" cy="23" r="8" fill="#FB923C" />
                <path d="M7 52C18 44 24 37 29 28c7 8 13 14 21 17C37 52 25 57 13 62Z" fill="#F97316" />
                <path d="M17 64c14-4 22-16 27-29 5-13 12-22 28-31-9 15-17 30-23 45-5 13-16 19-32 15Z" fill="#22C55E" />
                <path d="M30 31c-8 4-14 4-22 1 7-1 13-5 18-11 3 2 5 6 4 10Z" fill="#4ADE80" />
              </svg>
              <div className="leading-none">
                <div className="text-xl font-extrabold">SchemeSahayak</div>
                <div className="text-[11px] text-blue-100/80 mt-0.5">{tr('Government schemes, for you', 'सरकारी योजनाएँ, आपके लिए')}</div>
              </div>
            </div>
            <div className="w-12 h-[3px] bg-gov-saffron rounded-full mt-5 mb-4" />
            <h2 className="text-[26px] font-extrabold leading-tight">{tr('Select Location & State', 'राज्य एवं स्थान का चयन')}</h2>
            <p className="mt-3 text-[14px] text-blue-100/90 leading-relaxed max-w-[16rem]">
              {tr('Easily see the government schemes available for your state and check your eligibility.', 'अपने राज्य के अनुसार उपलब्ध सरकारी योजनाएँ आसानी से देखें और पात्रता जानें।')}
            </p>
          </div>

          {/* India illustration */}
          <div className="relative z-10 flex-1 flex items-center justify-center py-4">
            <div className="relative w-48 h-52">
              <IndiaGraphic />
              <div className="absolute top-6 -right-1 bg-white/10 backdrop-blur rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-right leading-tight border border-white/15">
                {tr('More benefits,', 'अधिक सुविधाएँ,')}<br />{tr('more opportunity', 'अधिक अवसर')}
              </div>
            </div>
          </div>

          <div className="relative z-10">
            <p className="text-[15px] font-semibold italic text-blue-50">{tr('Towards an inclusive India', 'एक समावेशी भारत की ओर')}</p>
            <p className="text-[10px] tracking-[0.2em] text-blue-200/70 font-bold mt-2">
              {tr('PEOPLE', 'लोग')} &nbsp;|&nbsp; {tr('SCHEMES', 'योजनाएँ')} &nbsp;|&nbsp; {tr('OPPORTUNITIES', 'अवसर')}
            </p>
          </div>
        </div>

        {/* ---------- RIGHT ACTION PANEL ---------- */}
        <div className="flex-1 p-6 sm:p-8 relative">
          <button
            onClick={onLocationDenied}
            className="absolute top-4 right-4 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-full p-1.5 transition-colors"
            aria-label={tr('Close', 'बंद करें')}
          >
            <X className="w-5 h-5" />
          </button>

          {!showManualDropdown ? (
            <div className="pt-2">
              <div className="w-14 h-14 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center mx-auto">
                <Navigation className="w-7 h-7 text-gov-navy" />
              </div>
              <p className="mt-4 text-sm text-slate-600 text-center max-w-sm mx-auto leading-relaxed">
                {tr('Share your location to unlock schemes and benefits specific to your state.', 'स्थान दर्ज करके अपने राज्य की विशेष योजनाएँ और लाभ प्राप्त करें।')}
              </p>

              {errorMsg && (
                <div className="mt-4 p-3 bg-amber-50 border border-amber-300 text-amber-900 text-xs font-semibold rounded-lg text-center">
                  {errorMsg}
                </div>
              )}

              <button
                onClick={handleGrantPermission}
                disabled={loading}
                className="mt-6 w-full py-2.5 rounded border-2 border-gov-saffron text-gov-saffron hover:bg-gov-saffron hover:text-white disabled:opacity-70 font-bold text-[14px] flex items-center justify-center gap-2 transition-colors"
              >
                {loading ? (
                  <span>{tr('Detecting Location…', 'स्थान खोजा जा रहा है…')}</span>
                ) : (
                  <>
                    <Navigation className="w-5 h-5" />
                    <span>{tr('Allow Location Permission', 'स्थान की अनुमति दें')}</span>
                    <ArrowRight className="w-5 h-5" />
                  </>
                )}
              </button>

              <p className="mt-3 text-[12px] text-slate-500 flex items-start gap-1.5 leading-relaxed">
                <ShieldCheck className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                {tr('Your location is used only to show schemes. We never store your precise location.', 'आपकी स्थिति का उपयोग केवल योजनाएँ दिखाने के लिए किया जाएगा। हम आपकी सटीक लोकेशन को स्टोर नहीं करते।')}
              </p>

              <button
                onClick={() => setShowManualDropdown(true)}
                disabled={loading}
                className="mt-3 w-full py-2.5 rounded border-2 border-gov-navy text-gov-navy hover:bg-gov-navy hover:text-white font-bold text-[14px] flex items-center justify-center gap-2 transition-colors"
              >
                <Building className="w-5 h-5" />
                <span>{tr('Select State Manually', 'मैन्युअल रूप से राज्य चुनें')}</span>
                <ArrowRight className="w-5 h-5" />
              </button>
            </div>
          ) : (
            /* ---- MANUAL STATE SELECTION ---- */
            <div className="pt-2 animate-in fade-in duration-150">
              <h3 className="text-xl font-extrabold text-gov-navy flex items-center gap-2">
                <Building className="w-5 h-5 text-gov-saffron" />
                {tr('Select Your State', 'अपना राज्य चुनें')}
              </h3>

              <div className="relative mt-4">
                <Search className="w-4 h-4 absolute left-3 top-3.5 text-slate-400" />
                <input
                  type="text"
                  placeholder={tr('Search state…', 'राज्य खोजें…')}
                  value={searchStateQuery}
                  onChange={(e) => setSearchStateQuery(e.target.value)}
                  className="w-full pl-9 pr-3 py-2.5 border-2 border-slate-300 rounded-lg text-sm font-bold focus:border-gov-navy focus:outline-none"
                />
              </div>

              <div className="max-h-[240px] overflow-y-auto border-2 border-slate-200 rounded-xl p-1 bg-slate-50 space-y-1 mt-3">
                {filteredStates.map((s) => (
                  <button
                    key={s.name}
                    onClick={() => handleSelectState(s)}
                    className="w-full p-2.5 rounded-lg text-left text-sm font-bold bg-white text-slate-800 hover:bg-gov-navy hover:text-white border border-slate-200 transition-colors"
                  >
                    {tr(s.name, s.name_hi)}
                  </button>
                ))}
              </div>

              <button
                onClick={() => setShowManualDropdown(false)}
                className="mt-3 text-xs text-slate-500 hover:text-slate-800 font-bold underline w-full text-center py-1"
              >
                ← {tr('Back to Auto-Location', 'वापस ऑटो-लोकेशन पर जाएँ')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
