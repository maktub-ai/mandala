import React from 'react';
import './brand-mark.css';

/** C / Open: a monochrome ribbon mark at every size. */
export default function BrandMark({ className = '' }: { className?: string }) {
  return <span className={`brand-mark ${className}`} aria-hidden="true" />;
}
