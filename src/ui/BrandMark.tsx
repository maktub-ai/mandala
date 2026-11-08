import React from 'react';
import './brand-mark.css';

/** C / Open: a monochrome ribbon mark; smaller chrome uses logo-small.svg. */
export default function BrandMark({ className = '' }: { className?: string }) {
  return <span className={`brand-mark ${className}`} aria-hidden="true" />;
}
