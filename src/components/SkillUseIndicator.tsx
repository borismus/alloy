import React from 'react';
import { SkillUse } from '../types';
import './SkillUseIndicator.css';

interface SkillUseIndicatorProps {
  skillUse: SkillUse[];
}

const SkillIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
  </svg>
);

export const SkillUseIndicator: React.FC<SkillUseIndicatorProps> = ({ skillUse }) => {
  if (skillUse.length === 0) return null;

  return (
    <div className="skill-use-indicators">
      {skillUse.map((skill, idx) => (
        <div key={idx} className="skill-use-indicator">
          <span className="skill-use-icon">
            <SkillIcon />
          </span>
          <span className="skill-use-label">{skill.name}</span>
        </div>
      ))}
    </div>
  );
};
