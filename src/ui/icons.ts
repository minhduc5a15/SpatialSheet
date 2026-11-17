export function svgIcon(
  name:
    | 'upload'
    | 'download'
    | 'table'
    | 'barChart'
    | 'lineChart'
    | 'pieChart'
    | 'scatterChart'
    | 'cube3d'
    | 'split'
    | 'plus'
    | 'trash'
    | 'undo'
    | 'redo'
    | 'search'
    | 'sortAsc'
    | 'sortDesc'
    | 'sortNone'
    | 'sparkles'
    | 'xr'
    | 'close'
    | 'edit',
  className = 'w-4 h-4'
): string {
  const common = `class="${className}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;

  switch (name) {
    case 'upload':
      return `<svg ${common}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
    case 'download':
      return `<svg ${common}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
    case 'table':
      return `<svg ${common}><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="9" x2="9" y2="21"/></svg>`;
    case 'barChart':
      return `<svg ${common}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`;
    case 'lineChart':
      return `<svg ${common}><polyline points="3 17 9 11 13 15 21 7"/><polyline points="17 7 21 7 21 11"/></svg>`;
    case 'pieChart':
      return `<svg ${common}><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>`;
    case 'scatterChart':
      return `<svg ${common}><circle cx="7.5" cy="14.5" r="1.5"/><circle cx="11.5" cy="9.5" r="1.5"/><circle cx="16.5" cy="12.5" r="1.5"/><circle cx="17.5" cy="6.5" r="1.5"/><path d="M3 3v18h18"/></svg>`;
    case 'cube3d':
      return `<svg ${common}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;
    case 'split':
      return `<svg ${common}><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`;
    case 'plus':
      return `<svg ${common}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    case 'trash':
      return `<svg ${common}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
    case 'undo':
      return `<svg ${common}><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>`;
    case 'redo':
      return `<svg ${common}><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>`;
    case 'search':
      return `<svg ${common}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
    case 'sortAsc':
      return `<svg ${common}><path d="M12 19V5"/><polyline points="7 10 12 5 17 10"/></svg>`;
    case 'sortDesc':
      return `<svg ${common}><path d="M12 5v14"/><polyline points="17 14 12 19 7 14"/></svg>`;
    case 'sortNone':
      return `<svg ${common}><polyline points="7 15 12 20 17 15"/><polyline points="7 9 12 4 17 9"/></svg>`;
    case 'xr':
      return `<svg ${common}><path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-3.2a2 2 0 0 1-1.79-1.11l-.55-1.1a1.5 1.5 0 0 0-2.92 0l-.55 1.1A2 2 0 0 1 8.2 17H5a2 2 0 0 1-2-2V9z"/><circle cx="7.5" cy="12" r="1.5"/><circle cx="16.5" cy="12" r="1.5"/></svg>`;
    case 'close':
      return `<svg ${common}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    case 'edit':
      return `<svg ${common}><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
    default:
      return `<svg ${common}><circle cx="12" cy="12" r="4"/></svg>`;
  }
}
