import './fonts.css';
import asset0 from "./assets/pos-02-balloon.png";
import asset1 from "./assets/pos-02-cake.png";
import asset2 from "./assets/pos-02-discoball.png";
import asset3 from "./assets/pos-02-hand.png";
import asset4 from "./assets/pos-02-portrait.png";
import asset5 from "./assets/pos-02-texture.png";

import React from 'react';

export function BirthdayCollage() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        backgroundImage: `url(${asset5})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
      className="relative overflow-hidden bg-[#e8e4db] shadow-inner"
    >
      {/* Background grain overlay */}
      <div className="absolute inset-0 opacity-20 pointer-events-none mix-blend-multiply" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.65%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22/%3E%3C/svg%3E")' }}></div>

      {/* Grid lines */}
      <div className="absolute inset-0 opacity-10 pointer-events-none" style={{ backgroundImage: 'linear-gradient(#000 1px, transparent 1px), linear-gradient(90deg, #000 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>

      {/* Torn paper edge top */}
      <div className="absolute top-0 left-0 w-full h-8 bg-white opacity-80" style={{ clipPath: 'polygon(0% 0%, 100% 0%, 100% 30%, 95% 70%, 90% 40%, 85% 90%, 80% 50%, 75% 80%, 70% 30%, 65% 100%, 60% 40%, 55% 80%, 50% 20%, 45% 90%, 40% 50%, 35% 80%, 30% 20%, 25% 100%, 20% 40%, 15% 90%, 10% 50%, 5% 70%, 0% 30%)' }}></div>

      {/* Portrait */}
      <div className="absolute top-[80px] left-[50px] w-[350px] h-[450px] rotate-[-4deg] shadow-xl border-[12px] border-white z-10 transition-transform hover:rotate-0 hover:scale-105 duration-300">
        <img 
          src={asset4} 
          alt="Birthday Portrait" 
          className="w-full h-full object-cover filter contrast-125 grayscale"
        />
        <div className="absolute bottom-[-10px] right-[-15px] bg-[#ff4a4a] text-white px-3 py-1 font-['Permanent_Marker'] text-xl rotate-[8deg] shadow-md border-2 border-black">
          THAT'S ME
        </div>
      </div>

      {/* Disco Ball */}
      <div className="absolute top-[40px] right-[40px] w-[220px] h-[220px] z-20 hover:scale-110 transition-transform duration-500 ease-out">
        <img 
          src={asset2} 
          alt="Disco Ball" 
          className="w-full h-full object-contain filter drop-shadow-2xl brightness-110"
        />
      </div>

      {/* Number Balloon */}
      <div className="absolute top-[280px] right-[20px] w-[260px] h-[300px] z-30 rotate-[12deg] hover:rotate-[15deg] hover:scale-105 transition-transform duration-300">
        <img 
          src={asset0} 
          alt="Number 30 Balloon" 
          className="w-full h-full object-contain filter drop-shadow-xl"
        />
      </div>

      {/* Pointing Hand */}
      <div className="absolute bottom-[350px] left-[20px] w-[180px] h-[150px] z-40 rotate-[25deg]">
        <img 
          src={asset3} 
          alt="Pointing Hand" 
          className="w-full h-full object-contain filter drop-shadow-lg"
        />
      </div>

      {/* Cake */}
      <div className="absolute bottom-[40px] right-[60px] w-[280px] h-[280px] z-30 rotate-[-5deg]">
        <img 
          src={asset1} 
          alt="Birthday Cake" 
          className="w-full h-full object-contain filter drop-shadow-2xl"
        />
      </div>

      {/* Text Elements */}
      
      {/* Title */}
      <div className="absolute top-[520px] left-[60px] z-40 flex flex-col gap-2">
        <div className="bg-black text-[#f4f0e6] px-4 py-2 font-['Bebas_Neue'] text-7xl uppercase tracking-wider w-max border-l-[6px] border-[#ff4a4a] rotate-[-2deg] shadow-lg mix-blend-normal">
          IT'S A PARTY
        </div>
        <div className="bg-white text-black px-4 py-2 font-['Caveat'] text-5xl font-bold w-max border-2 border-black rotate-[1deg] shadow-[4px_4px_0px_#000] ml-12">
          for Julian's 30th
        </div>
      </div>

      {/* Details Box */}
      <div className="absolute bottom-[80px] left-[60px] z-40 bg-[#fffdf5] border-[3px] border-black p-6 shadow-[8px_8px_0px_rgba(0,0,0,1)] w-[320px] rotate-[-2deg] bg-opacity-95">
        
        {/* Tape piece */}
        <div className="absolute top-[-15px] left-1/2 -translate-x-1/2 w-24 h-8 bg-white/60 border border-gray-200/50 rotate-[2deg] shadow-sm mix-blend-overlay"></div>

        <div className="space-y-4 text-black">
          <div className="flex flex-col">
            <span className="font-['Space_Mono'] text-xs font-bold uppercase tracking-widest text-[#ff4a4a]">When</span>
            <span className="font-['Permanent_Marker'] text-2xl">SAT, OCT 14</span>
            <span className="font-['Caveat'] text-2xl font-bold">@ 9:00 PM 'til late</span>
          </div>

          <div className="w-full h-[2px] bg-black/20" style={{ borderBottom: '2px dashed rgba(0,0,0,0.2)', backgroundColor: 'transparent' }}></div>

          <div className="flex flex-col">
            <span className="font-['Space_Mono'] text-xs font-bold uppercase tracking-widest text-[#ff4a4a]">Where</span>
            <span className="font-['Bebas_Neue'] text-3xl tracking-wide">THE WAREHOUSE</span>
            <span className="font-['Space_Mono'] text-sm font-semibold">1248 NEON AVENUE, BROOKLYN</span>
          </div>
          
          <div className="w-full h-[2px] bg-black/20" style={{ borderBottom: '2px dashed rgba(0,0,0,0.2)', backgroundColor: 'transparent' }}></div>

          <div className="flex flex-col">
            <span className="font-['Space_Mono'] text-xs font-bold uppercase tracking-widest text-[#ff4a4a]">Dress Code</span>
            <span className="font-['Caveat'] text-2xl font-bold bg-[#ffff00] px-2 py-0.5 w-max transform rotate-[-1deg] border border-black/10">Glitter & Grunge</span>
          </div>
        </div>
      </div>

      {/* Floating stickers / decorative elements */}
      <div className="absolute top-[480px] left-[320px] bg-[#ffff00] text-black w-24 h-24 rounded-full flex items-center justify-center font-['Bebas_Neue'] text-2xl border-4 border-black border-dashed rotate-[15deg] shadow-md z-50">
        <div className="text-center leading-none">NO<br/>GIFTS<br/>PLZ</div>
      </div>
      
      <div className="absolute top-[60px] left-[380px] font-['Caveat'] text-4xl text-black rotate-[35deg] opacity-80 z-20 bg-white/50 px-2 mix-blend-hard-light">
        omg
      </div>

      {/* Cutout shapes */}
      <svg className="absolute bottom-[280px] right-[40px] w-16 h-16 text-[#ff4a4a] rotate-[45deg] z-20 drop-shadow-md" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
      </svg>
      
      <svg className="absolute top-[320px] left-[20px] w-10 h-10 text-black rotate-[-15deg] z-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
        <path d="M5 12L19 12M12 5L12 19" />
      </svg>
      
    </div>
  );
}
