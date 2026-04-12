/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Hexagon, 
  Map as MapIcon, 
  Share2, 
  Play, 
  Pause, 
  RotateCcw, 
  Plus, 
  Minus, 
  Target, 
  ChevronDown,
  Info,
  CheckCircle2,
  AlertCircle,
  Activity
} from 'lucide-react';

declare global {
  interface Window {
    d3: any;
    topojson: any;
  }
}

// --- Constants ---
const COLORS = [
  '#00d4ff', // Cyan
  '#ff3388', // Rose
  '#00ffaa', // Mint
  '#ffcc33', // Amber
  '#bb44ff', // Violet
  '#ff7722', // Orange
];

const COLOR_NAMES = ['Cyan', 'Rose', 'Mint', 'Amber', 'Violet', 'Orange'];

const MAP_DATA_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';

// --- Types ---
interface Region {
  id: string;
  name: string;
  neighbors: string[];
  color: number | null;
  feature: any;
}

interface SolveState {
  stack: { regionIndex: number; colorIndex: number }[];
  assignments: Map<string, number | null>;
  currentRegionIndex: number;
  isSolving: boolean;
  isPaused: boolean;
  isDone: boolean;
  backtracks: number;
  steps: number;
}

export default function App() {
  // --- Refs ---
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const graphContainerRef = useRef<HTMLDivElement>(null);
  const svgMapRef = useRef<SVGSVGElement>(null);
  const svgGraphRef = useRef<SVGSVGElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  
  // D3 Selection Refs to prevent re-rendering flicker
  const d3MapSelectionRef = useRef<any>(null);
  const d3GraphSelectionRef = useRef<any>(null);
  const d3MapZoomRef = useRef<any>(null);
  const d3GraphZoomRef = useRef<any>(null);
  const d3MapGRef = useRef<any>(null);
  const d3GraphGRef = useRef<any>(null);
  const d3SimulationRef = useRef<any>(null);

  // --- State ---
  const [view, setView] = useState<'map' | 'graph'>('map');
  const [numColors, setNumColors] = useState(4);
  const [speed, setSpeed] = useState(500); // ms delay
  const [regions, setRegions] = useState<Region[]>([]);
  const [solveState, setSolveState] = useState<SolveState>({
    stack: [],
    assignments: new Map(),
    currentRegionIndex: -1,
    isSolving: false,
    isPaused: false,
    isDone: false,
    backtracks: 0,
    steps: 0,
  });
  const [logs, setLogs] = useState<{ time: string; msg: string; type: 'info' | 'success' | 'error' | 'backtrack' }[]>([]);
  const [orderedIds, setOrderedIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // --- Initialization ---
  useEffect(() => {
    const loadData = async () => {
      try {
        setIsLoading(true);
        setError(null);
        
        // Check for D3 and TopoJSON
        if (!window.d3 || !window.topojson) {
          // Wait a bit and check again (CDN might be slow)
          await new Promise(resolve => setTimeout(resolve, 1000));
          if (!window.d3 || !window.topojson) {
            throw new Error('Visualization libraries (D3/TopoJSON) failed to load. Please check your internet connection.');
          }
        }

        const response = await fetch(MAP_DATA_URL);
        if (!response.ok) throw new Error('Failed to fetch map data.');
        const world = await response.json();
        // @ts-ignore
        const countries = window.topojson.feature(world, world.objects.countries);
        // @ts-ignore
        const neighbors = window.topojson.neighbors(world.objects.countries.geometries);

        const regionList: Region[] = countries.features.map((feature: any, i: number) => ({
          id: feature.id,
          name: feature.properties.name,
          neighbors: neighbors[i].map((neighborIdx: number) => countries.features[neighborIdx].id),
          color: null,
          feature: feature,
        }));

        setRegions(regionList);
        
        // MRV Proxy: Sort by degree descending
        const sorted = [...regionList].sort((a, b) => b.neighbors.length - a.neighbors.length);
        setOrderedIds(sorted.map(r => r.id));
        
        addLog('World map data loaded. Adjacency graph built.', 'info');
        setIsLoading(false);
      } catch (err: any) {
        console.error('Failed to load map data:', err);
        setError(err.message || 'Unknown error occurred during initialization.');
        addLog('Error: ' + (err.message || 'Data load failed'), 'error');
        setIsLoading(false);
      }
    };

    loadData();
  }, []);

  // --- Log Helper ---
  const addLog = (msg: string, type: 'info' | 'success' | 'error' | 'backtrack') => {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    setLogs(prev => [...prev.slice(-50), { time, msg, type }]);
  };

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // --- Algorithm Logic ---
  const isValid = (regionId: string, colorIndex: number, assignments: Map<string, number | null>) => {
    const region = regions.find(r => r.id === regionId);
    if (!region) return false;
    for (const neighborId of region.neighbors) {
      if (assignments.get(neighborId) === colorIndex) return false;
    }
    return true;
  };

  const tick = () => {
    setSolveState(prev => {
      if (prev.isPaused || prev.isDone || !prev.isSolving) return prev;

      const newStack = [...prev.stack];
      const newAssignments = new Map<string, number | null>(prev.assignments);
      let newCurrentIndex = prev.currentRegionIndex;
      let newBacktracks = prev.backtracks;
      let newSteps = prev.steps + 1;

      if (newCurrentIndex === -1) {
        // Start
        newCurrentIndex = 0;
        newStack.push({ regionIndex: 0, colorIndex: 0 });
      }

      if (newStack.length === 0) {
        addLog('No solution found with current constraints.', 'error');
        return { ...prev, isSolving: false, isDone: true };
      }

      const currentFrame = newStack[newStack.length - 1];
      const currentRegionId = orderedIds[currentFrame.regionIndex];
      const currentRegion = regions.find(r => r.id === currentRegionId)!;

      // Try current color
      if (currentFrame.colorIndex < numColors) {
        if (isValid(currentRegionId, currentFrame.colorIndex, newAssignments)) {
          // Success for this region
          newAssignments.set(currentRegionId, currentFrame.colorIndex);
          addLog(`Assigned ${currentRegion.name} → ${COLOR_NAMES[currentFrame.colorIndex]}`, 'success');

          if (newStack.length === orderedIds.length) {
            // All colored!
            addLog('✅ All regions colored successfully!', 'success');
            return {
              ...prev,
              assignments: newAssignments,
              isSolving: false,
              isDone: true,
              steps: newSteps,
            };
          }

          // Move to next region
          newStack.push({ regionIndex: newStack.length, colorIndex: 0 });
          return {
            ...prev,
            stack: newStack,
            assignments: newAssignments,
            currentRegionIndex: newStack.length - 1,
            steps: newSteps,
          };
        } else {
          // Conflict, try next color
          currentFrame.colorIndex++;
          return {
            ...prev,
            stack: newStack,
            steps: newSteps,
          };
        }
      } else {
        // Backtrack
        newBacktracks++;
        newStack.pop();
        if (newStack.length > 0) {
          const parentFrame = newStack[newStack.length - 1];
          const parentRegionId = orderedIds[parentFrame.regionIndex];
          const parentRegion = regions.find(r => r.id === parentRegionId)!;
          newAssignments.set(parentRegionId, null);
          parentFrame.colorIndex++;
          addLog(`↩ Backtracking from ${currentRegion.name}`, 'backtrack');
        }
        
        return {
          ...prev,
          stack: newStack,
          assignments: newAssignments,
          currentRegionIndex: newStack.length - 1,
          backtracks: newBacktracks,
          steps: newSteps,
        };
      }
    });
  };

  useEffect(() => {
    if (solveState.isSolving && !solveState.isPaused && !solveState.isDone) {
      timerRef.current = window.setTimeout(tick, speed);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [solveState, speed]);

  // --- D3 Map Initialization ---
  useEffect(() => {
    if (!svgMapRef.current || regions.length === 0) return;

    const d3 = window.d3;
    const svg = d3.select(svgMapRef.current);
    
    const updateDimensions = () => {
      const width = mapContainerRef.current?.clientWidth || 800;
      const height = mapContainerRef.current?.clientHeight || 600;
      if (width < 100 || height < 100) return;

      svg.selectAll('*').remove();
      const g = svg.append('g');
      d3MapGRef.current = g;

      const projection = d3.geoNaturalEarth1().fitSize([width, height], { type: 'FeatureCollection', features: regions.map(r => r.feature) });
      const path = d3.geoPath().projection(projection);

      g.append('path')
        .datum({ type: 'Sphere' })
        .attr('class', 'sphere')
        .attr('d', path)
        .attr('fill', 'rgba(12, 22, 40, 0.7)');

      g.append('path')
        .datum(d3.geoGraticule())
        .attr('class', 'graticule')
        .attr('d', path)
        .attr('fill', 'none')
        .attr('stroke', 'rgba(0, 212, 255, 0.05)')
        .attr('stroke-width', 0.5);

      const countries = g.selectAll('.country')
        .data(regions)
        .enter()
        .append('path')
        .attr('class', 'country')
        .attr('d', d => path(d.feature))
        .attr('id', d => `country-${d.id}`)
        .attr('fill', '#0c1628')
        .attr('stroke', 'rgba(255,255,255,0.15)')
        .attr('stroke-width', 0.5);

      d3MapSelectionRef.current = countries;

      const zoom = d3.zoom()
        .scaleExtent([0.3, 12])
        .on('zoom', (event: any) => {
          g.attr('transform', event.transform);
        })
        .filter((event: any) => {
          // Disable wheel zoom to allow page scrolling
          return event.type !== 'wheel';
        });

      d3MapZoomRef.current = zoom;
      svg.call(zoom as any);

      svg.transition().duration(750).call(
        zoom.transform as any,
        d3.zoomIdentity
      );
    };

    updateDimensions();
    
    const resizeObserver = new ResizeObserver(() => updateDimensions());
    if (mapContainerRef.current) resizeObserver.observe(mapContainerRef.current);
    
    return () => resizeObserver.disconnect();
  }, [regions]);

  // --- D3 Map Update ---
  useEffect(() => {
    if (!d3MapSelectionRef.current) return;

    const d3 = window.d3;
    const currentId = orderedIds[solveState.currentRegionIndex];

    d3MapSelectionRef.current.transition()
      .duration(speed < 300 ? 100 : 380)
      .attr('fill', (d: any) => {
        const colorIdx = solveState.assignments.get(d.id);
        return colorIdx !== null && colorIdx !== undefined ? COLORS[colorIdx] : '#0c1628';
      })
      .attr('stroke', (d: any) => d.id === currentId ? '#fff' : 'rgba(255,255,255,0.12)')
      .attr('stroke-width', (d: any) => d.id === currentId ? 2 : 0.5)
      .attr('filter', (d: any) => d.id === currentId ? 'drop-shadow(0 0 12px white) brightness(1.6)' : 'none');

    d3MapSelectionRef.current.classed('animate-pulse-stroke', (d: any) => d.id === currentId);
  }, [solveState.assignments, solveState.currentRegionIndex, speed]);

  // --- D3 Graph Initialization ---
  useEffect(() => {
    if (!svgGraphRef.current || regions.length === 0) return;

    const d3 = window.d3;
    const svg = d3.select(svgGraphRef.current);
    
    const updateDimensions = () => {
      const width = graphContainerRef.current?.clientWidth || 800;
      const height = graphContainerRef.current?.clientHeight || 600;
      if (width < 100 || height < 100) return;

      svg.selectAll('*').remove();
      const g = svg.append('g');
      d3GraphGRef.current = g;

      const nodes = regions.map(r => ({ ...r }));
      const links: any[] = [];
      regions.forEach(r => {
        r.neighbors.forEach(nId => {
          if (r.id < nId) links.push({ source: r.id, target: nId });
        });
      });

      const simulation = d3.forceSimulation(nodes as any)
        .force('link', d3.forceLink(links).id((d: any) => d.id).distance(100))
        .force('charge', d3.forceManyBody().strength(-400))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collide', d3.forceCollide().radius((d: any) => (8 + d.neighbors.length * 1.2) + 20));

      d3SimulationRef.current = simulation;

      const link = g.append('g')
        .selectAll('line')
        .data(links)
        .enter()
        .append('line')
        .attr('class', 'edge')
        .attr('stroke', 'rgba(255,255,255,0.15)')
        .attr('stroke-width', 1.5);

      const node = g.append('g')
        .selectAll('.node-group')
        .data(nodes)
        .enter()
        .append('g')
        .attr('class', 'node-group')
        .call(d3.drag()
          .on('start', (event: any, d: any) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
          })
          .on('drag', (event: any, d: any) => {
            d.fx = event.x; d.fy = event.y;
          })
          .on('end', (event: any, d: any) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null; d.fy = null;
          }) as any);

      node.append('circle')
        .attr('class', 'node')
        .attr('r', d => Math.min(22, 8 + d.neighbors.length * 1.2))
        .attr('fill', '#1a2540')
        .attr('stroke', 'rgba(255,255,255,0.3)')
        .attr('stroke-width', 1.5);

      node.append('text')
        .text(d => d.name)
        .attr('font-family', 'Space Mono')
        .attr('font-size', '9px')
        .attr('fill', '#fff')
        .attr('text-anchor', 'middle')
        .attr('dy', '.3em')
        .attr('pointer-events', 'none')
        .attr('font-weight', 'bold');

      d3GraphSelectionRef.current = { node, link };

      simulation.on('tick', () => {
        link.attr('x1', d => d.source.x).attr('y1', d => d.source.y).attr('x2', d => d.target.x).attr('y2', d => d.target.y);
        node.attr('transform', d => `translate(${d.x},${d.y})`);
      });

      const zoom = d3.zoom()
        .scaleExtent([0.1, 8])
        .on('zoom', (event: any) => {
          g.attr('transform', event.transform);
        })
        .filter((event: any) => {
          return event.type !== 'wheel';
        });

      d3GraphZoomRef.current = zoom;
      svg.call(zoom as any);
    };

    updateDimensions();
    
    const resizeObserver = new ResizeObserver(() => updateDimensions());
    if (graphContainerRef.current) resizeObserver.observe(graphContainerRef.current);
    
    return () => resizeObserver.disconnect();
  }, [regions]);

  // --- D3 Graph Update ---
  useEffect(() => {
    if (!d3GraphSelectionRef.current || view !== 'graph') return;

    const d3 = window.d3;
    const { node, link } = d3GraphSelectionRef.current;
    const currentId = orderedIds[solveState.currentRegionIndex];

    node.select('circle').transition()
      .duration(speed < 300 ? 100 : 380)
      .attr('fill', (d: any) => {
        const colorIdx = solveState.assignments.get(d.id);
        return colorIdx !== null && colorIdx !== undefined ? COLORS[colorIdx] : '#1a2540';
      })
      .attr('stroke', (d: any) => d.id === currentId ? '#fff' : 'rgba(255,255,255,0.2)')
      .attr('stroke-width', (d: any) => d.id === currentId ? 3 : 1.5)
      .attr('transform', (d: any) => d.id === currentId ? 'scale(1.25)' : 'scale(1)')
      .attr('filter', (d: any) => d.id === currentId ? 'drop-shadow(0 0 15px white)' : 'none');

    link.transition()
      .duration(500)
      .attr('stroke', (d: any) => {
        const sColor = solveState.assignments.get(d.source.id);
        const tColor = solveState.assignments.get(d.target.id);
        if (sColor !== null && tColor !== null) return COLORS[sColor];
        return 'rgba(255,255,255,0.08)';
      })
      .attr('opacity', (d: any) => {
        const sColor = solveState.assignments.get(d.source.id);
        const tColor = solveState.assignments.get(d.target.id);
        return (sColor !== null && tColor !== null) ? 0.6 : 0.15;
      })
      .attr('stroke-width', (d: any) => {
        const sColor = solveState.assignments.get(d.source.id);
        const tColor = solveState.assignments.get(d.target.id);
        return (sColor !== null && tColor !== null) ? 2.5 : 1.5;
      });
  }, [solveState.assignments, solveState.currentRegionIndex, speed, view]);

  // --- Zoom Handlers ---
  const handleZoom = (delta: number) => {
    const d3 = window.d3;
    const svg = view === 'map' ? d3.select(svgMapRef.current) : d3.select(svgGraphRef.current);
    const zoom = view === 'map' ? d3MapZoomRef.current : d3GraphZoomRef.current;
    if (!svg || !zoom) return;

    svg.transition().duration(300).call(zoom.scaleBy as any, delta > 0 ? 1.5 : 0.66);
  };

  const handleResetZoom = () => {
    const d3 = window.d3;
    const svg = view === 'map' ? d3.select(svgMapRef.current) : d3.select(svgGraphRef.current);
    const zoom = view === 'map' ? d3MapZoomRef.current : d3GraphZoomRef.current;
    if (!svg || !zoom) return;

    svg.transition().duration(500).call(zoom.transform as any, d3.zoomIdentity);
  };

  // --- Controls ---
  const handleStart = () => {
    if (solveState.isDone) handleReset();
    setSolveState(prev => ({ ...prev, isSolving: true, isPaused: false }));
    addLog('Algorithm started...', 'info');
  };

  const handlePause = () => {
    setSolveState(prev => ({ ...prev, isPaused: !prev.isPaused }));
    addLog(solveState.isPaused ? 'Resumed' : 'Paused', 'info');
  };

  const handleReset = () => {
    setSolveState({
      stack: [],
      assignments: new Map(),
      currentRegionIndex: -1,
      isSolving: false,
      isPaused: false,
      isDone: false,
      backtracks: 0,
      steps: 0,
    });
    addLog('System reset.', 'info');
  };

  // --- Derived ---
  const progress = useMemo(() => {
    if (regions.length === 0) return 0;
    const colored = Array.from(solveState.assignments.values()).filter(v => v !== null).length;
    return Math.round((colored / regions.length) * 100);
  }, [solveState.assignments, regions]);

  const currentRegion = useMemo(() => {
    if (solveState.currentRegionIndex === -1) return null;
    const id = orderedIds[solveState.currentRegionIndex];
    return regions.find(r => r.id === id);
  }, [solveState.currentRegionIndex, regions, orderedIds]);

  // --- Theory Section Observer ---
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
        }
      });
    }, { threshold: 0.1 });

    document.querySelectorAll('.card-theory').forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <div className="bg-layers">
        <div className="orb orb-1"></div>
        <div className="orb orb-2"></div>
        <div className="orb orb-3"></div>
        <div className="dot-grid"></div>
        <div className="grain"></div>
      </div>

      {/* Header */}
      <header className="glass-header">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-gradient-to-br from-accent2 to-accent rounded-xl flex items-center justify-center shadow-[0_0_15px_rgba(0,212,255,0.3)]">
            <Hexagon className="text-bg w-6 h-6" />
          </div>
          <div>
            <h1 className="font-syne font-extrabold text-lg leading-tight">
              AI Map Coloring <span className="text-accent">Visualizer</span>
            </h1>
            <p className="font-mono text-[10px] text-t3 uppercase tracking-wider">
              Backtracking · CSP · Graph Theory
            </p>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10">
            <div className={`w-2 h-2 rounded-full ${
              solveState.isSolving && !solveState.isPaused ? 'bg-accent animate-pulse' : 
              solveState.isDone ? 'bg-green' : 
              solveState.isPaused ? 'bg-yellow' : 'bg-t3'
            }`} />
            <span className="font-mono text-[11px] text-t2">
              {solveState.isSolving && !solveState.isPaused ? 'Solving...' : 
               solveState.isDone ? 'Solved!' : 
               solveState.isPaused ? 'Paused' : 'Ready'}
            </span>
          </div>
          <span className="font-mono text-xs text-t3">by Varsha M</span>
        </div>
      </header>

      {/* Main Section */}
      <section className="h-[calc(100vh-68px)] flex overflow-hidden relative">
        <div className="scanline"></div>
        
        {/* Left Panel */}
        <aside className="panel-left">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-accent">
              <Hexagon className="w-4 h-4" />
              <span className="font-syne font-bold text-sm uppercase tracking-wider">Algorithm Badge</span>
            </div>
            <div className="glass p-4 rounded-xl border-t-accent/30 bg-accent/5">
              <h3 className="font-syne font-bold text-accent">Backtracking Search</h3>
              <p className="font-mono text-[10px] text-t2">CSP · MRV Heuristic</p>
            </div>
          </div>

          <div className="space-y-4">
            <label className="font-mono text-[10px] text-t3 uppercase tracking-widest">Color Count</label>
            <div className="flex items-center justify-between">
              <button 
                onClick={() => setNumColors(Math.max(2, numColors - 1))}
                className="w-10 h-10 rounded-lg border border-border flex items-center justify-center hover:bg-white/5 transition-colors"
              >
                <Minus className="w-4 h-4" />
              </button>
              <span className="font-syne font-extrabold text-4xl">{numColors}</span>
              <button 
                onClick={() => setNumColors(Math.min(6, numColors + 1))}
                className="w-10 h-10 rounded-lg border border-border flex items-center justify-center hover:bg-white/5 transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
            <div className="flex gap-2 justify-center">
              {COLORS.slice(0, numColors).map((c, i) => (
                <div key={i} className="w-3 h-3 rounded-full shadow-[0_0_8px_rgba(255,255,255,0.2)]" style={{ backgroundColor: c }} />
              ))}
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex justify-between font-mono text-[10px] text-t3 uppercase tracking-widest">
              <span>Slow</span>
              <span>Fast</span>
            </div>
            <input 
              type="range" 
              min="50" 
              max="1500" 
              step="50"
              value={1550 - speed}
              onChange={(e) => setSpeed(1550 - parseInt(e.target.value))}
              className="w-full accent-accent bg-border h-1 rounded-full appearance-none cursor-pointer"
            />
          </div>

          <div className="flex flex-col gap-3">
            {!solveState.isSolving || solveState.isPaused ? (
              <button onClick={handleStart} className="btn-primary flex items-center justify-center gap-2">
                <Play className="w-4 h-4 fill-current" />
                {solveState.isPaused ? 'RESUME' : 'START SOLVER'}
              </button>
            ) : (
              <button onClick={handlePause} className="btn-outline flex items-center justify-center gap-2">
                <Pause className="w-4 h-4 fill-current" />
                PAUSE
              </button>
            )}
            <button onClick={handleReset} className="btn-ghost flex items-center justify-center gap-2">
              <RotateCcw className="w-4 h-4" />
              RESET
            </button>
          </div>

          <div className="mt-auto flex flex-col items-center gap-4">
            <div className="relative w-32 h-32 flex items-center justify-center">
              <svg className="w-full h-full -rotate-90">
                <circle 
                  cx="64" cy="64" r="58" 
                  className="stroke-border fill-none" 
                  strokeWidth="4" 
                />
                <circle 
                  cx="64" cy="64" r="58" 
                  className="stroke-accent fill-none transition-all duration-500 ease-out" 
                  strokeWidth="4" 
                  strokeDasharray={364.4}
                  strokeDashoffset={364.4 - (364.4 * progress) / 100}
                  strokeLinecap="round"
                  style={{ filter: 'drop-shadow(0 0 4px #00d4ff)' }}
                />
              </svg>
              <div className="absolute flex flex-col items-center">
                <span className="font-syne font-extrabold text-2xl">{progress}%</span>
                <span className="font-mono text-[8px] text-t3 uppercase">colored</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 w-full">
              {[
                { label: 'Regions', val: regions.length },
                { label: 'Colored', val: Array.from(solveState.assignments.values()).filter(v => v !== null).length },
                { label: 'Backtracks', val: solveState.backtracks },
                { label: 'Steps', val: solveState.steps },
              ].map((stat, i) => (
                <div key={i} className="glass p-3 rounded-xl flex flex-col items-center">
                  <span className="font-syne font-bold text-lg text-accent">{stat.val}</span>
                  <span className="font-mono text-[8px] text-t3 uppercase">{stat.label}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* Center Canvas */}
        <main className="flex-1 relative bg-bg2/50">
          <div className="absolute top-6 left-1/2 -translate-x-1/2 z-10">
            <div className="glass p-1 rounded-full flex gap-1">
              <button 
                onClick={() => setView('map')}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-full font-mono text-[11px] transition-all ${view === 'map' ? 'bg-accent text-bg shadow-[0_0_12px_rgba(0,212,255,0.4)]' : 'text-t2 hover:text-t1'}`}
              >
                <MapIcon className="w-3 h-3" />
                MAP VIEW
              </button>
              <button 
                onClick={() => setView('graph')}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-full font-mono text-[11px] transition-all ${view === 'graph' ? 'bg-accent text-bg shadow-[0_0_12px_rgba(0,212,255,0.4)]' : 'text-t2 hover:text-t1'}`}
              >
                <Share2 className="w-3 h-3" />
                GRAPH VIEW
              </button>
            </div>
          </div>

          <div className="w-full h-full relative overflow-hidden">
            {isLoading && (
              <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-bg/90 backdrop-blur-xl">
                <div className="w-20 h-20 border-4 border-accent/10 border-t-accent rounded-full animate-spin mb-6" />
                <div className="text-center space-y-2">
                  <p className="font-syne font-bold text-xl text-t1 tracking-widest uppercase">Initializing Neural Map</p>
                  <p className="font-mono text-[10px] text-accent animate-pulse uppercase tracking-[0.3em]">Establishing Satellite Link...</p>
                </div>
              </div>
            )}

            {error && (
              <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-bg/95 backdrop-blur-2xl p-12 text-center">
                <AlertCircle className="w-16 h-16 text-red mb-6 animate-pulse" />
                <h3 className="font-syne font-bold text-2xl text-red mb-2 uppercase">System Failure</h3>
                <p className="font-mono text-sm text-t2 max-w-md mb-8">{error}</p>
                <button 
                  onClick={() => window.location.reload()}
                  className="btn-primary flex items-center gap-2"
                >
                  <RotateCcw className="w-4 h-4" />
                  REBOOT SYSTEM
                </button>
              </div>
            )}
            
            {/* Mission Control Overlays */}
            <div className="absolute inset-0 pointer-events-none z-10">
              <div className="absolute top-4 left-4 font-mono text-[9px] text-accent/40 flex flex-col gap-1">
                <span>LAT: 0.0000°</span>
                <span>LON: 0.0000°</span>
                <span>ALT: 420KM</span>
              </div>
              <div className="absolute top-4 right-4 font-mono text-[9px] text-accent/40 flex flex-col items-end gap-1">
                <span>SYS_READY: TRUE</span>
                <span>ENCRYPTION: AES-256</span>
                <span>BUFFER: 100%</span>
              </div>
              <div className="absolute bottom-4 left-4 font-mono text-[9px] text-accent/40">
                <span>© 2026 MISSION_CONTROL_V2.0</span>
              </div>
            </div>

            {/* Map Container */}
            <div 
              ref={mapContainerRef}
              className={`absolute inset-0 transition-opacity duration-500 ${view === 'map' ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
            >
              <svg ref={svgMapRef} className="w-full h-full" />
            </div>

            {/* Graph Container */}
            <div 
              ref={graphContainerRef}
              className={`absolute inset-0 transition-opacity duration-500 ${view === 'graph' ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
            >
              <svg ref={svgGraphRef} className="w-full h-full" />
            </div>
          </div>

          {/* Zoom Controls */}
          <div className="absolute bottom-6 right-6 flex flex-col gap-2">
            <button 
              onClick={() => handleZoom(1)}
              className="w-10 h-10 glass rounded-lg flex items-center justify-center hover:bg-white/10 hover:text-accent transition-all active:scale-90"
            >
              <Plus className="w-4 h-4" />
            </button>
            <button 
              onClick={() => handleZoom(-1)}
              className="w-10 h-10 glass rounded-lg flex items-center justify-center hover:bg-white/10 hover:text-accent transition-all active:scale-90"
            >
              <Minus className="w-4 h-4" />
            </button>
            <button 
              onClick={handleResetZoom}
              className="w-10 h-10 glass rounded-lg flex items-center justify-center hover:bg-white/10 hover:text-accent transition-all active:scale-90"
            >
              <Target className="w-4 h-4 text-accent" />
            </button>
          </div>

          {/* Top Progress Line */}
          <div className="absolute top-0 left-0 w-full h-[2px] bg-white/5 overflow-hidden">
            <motion.div 
              className="h-full bg-gradient-to-r from-accent to-green"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.5 }}
            />
          </div>
        </main>

        {/* Right Panel */}
        <aside className="panel-right">
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-accent">
              <Activity className="w-4 h-4" />
              <span className="font-syne font-bold text-sm uppercase tracking-wider">Status Board</span>
            </div>
            <div className="glass p-4 rounded-xl flex items-center gap-3">
              <div className={`w-2 h-2 rounded-full ${solveState.isSolving ? 'bg-accent animate-pulse' : solveState.isDone ? 'bg-green' : 'bg-t3'}`} />
              <span className="font-mono text-[11px] text-t1 truncate">
                {solveState.isSolving ? `Solving: ${currentRegion?.name || '...'}` : solveState.isDone ? '✅ Solution Found!' : 'System Standby'}
              </span>
            </div>
          </div>

          <div className="space-y-2 flex-1 flex flex-col min-h-[150px]">
            <label className="font-mono text-[10px] text-t3 uppercase tracking-widest">Live Execution Log</label>
            <div className="flex-1 glass bg-black/40 rounded-xl p-3 font-mono text-[10px] overflow-y-auto space-y-1 scroll-smooth">
              {logs.map((log, i) => (
                <motion.div 
                  key={i}
                  initial={{ opacity: 0, x: -5 }}
                  animate={{ opacity: 1, x: 0 }}
                  className={`flex gap-2 ${
                    log.type === 'success' ? 'text-green' : 
                    log.type === 'backtrack' ? 'text-red' : 
                    log.type === 'error' ? 'text-red font-bold' : 'text-t2'
                  }`}
                >
                  <span className="opacity-40">[{log.time}]</span>
                  <span>{log.msg}</span>
                </motion.div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>

          <div className="space-y-4">
            <label className="font-mono text-[10px] text-t3 uppercase tracking-widest">Current Focus</label>
            <div 
              className="glass p-4 rounded-xl border-t-2 transition-all duration-500 relative overflow-hidden group" 
              style={{ borderTopColor: currentRegion && solveState.assignments.get(currentRegion.id) !== null ? COLORS[solveState.assignments.get(currentRegion.id)!] : 'rgba(255,255,255,0.1)' }}
            >
              <div className="absolute -right-4 -top-4 w-16 h-16 bg-accent/5 rounded-full blur-2xl group-hover:bg-accent/10 transition-all" />
              <h4 className="font-syne font-bold text-lg relative z-10">{currentRegion?.name || '---'}</h4>
              <div className="flex items-center gap-2 mt-2 relative z-10">
                <div 
                  className="w-3 h-3 rounded-full shadow-[0_0_10px_rgba(255,255,255,0.2)]" 
                  style={{ 
                    backgroundColor: currentRegion && solveState.assignments.get(currentRegion.id) !== null ? COLORS[solveState.assignments.get(currentRegion.id)!] : '#333',
                    boxShadow: currentRegion && solveState.assignments.get(currentRegion.id) !== null ? `0 0 15px ${COLORS[solveState.assignments.get(currentRegion.id)!]}` : 'none'
                  }} 
                />
                <span className="font-mono text-[10px] text-t2">
                  {currentRegion && solveState.assignments.get(currentRegion.id) !== null ? COLOR_NAMES[solveState.assignments.get(currentRegion.id)!] : 'Unassigned'}
                </span>
              </div>
              <div className="mt-4 pt-4 border-t border-white/5 flex justify-between text-[10px] font-mono text-t3 relative z-10">
                <div className="flex flex-col">
                  <span className="opacity-50">NEIGHBORS</span>
                  <span className="text-t2 font-bold">{currentRegion?.neighbors.length || 0}</span>
                </div>
                <div className="flex flex-col items-end">
                  <span className="opacity-50">REGION_ID</span>
                  <span className="text-t2 font-bold">{currentRegion?.id || '---'}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <label className="font-mono text-[10px] text-t3 uppercase tracking-widest">Algorithm Steps</label>
            <div className="grid grid-cols-1 gap-2">
              {[
                'Model as Graph',
                'MRV Heuristic',
                'Try a Color',
                'Check Constraint',
                'Backtrack',
                '4-Color Theorem'
              ].map((step, i) => {
                const isActive = solveState.isSolving && (
                  (i === 0) || 
                  (i === 1 && solveState.steps > 0) ||
                  (i === 2 && !solveState.isPaused) ||
                  (i === 3 && !solveState.isPaused) ||
                  (i === 4 && solveState.backtracks > 0) ||
                  (i === 5 && solveState.isDone)
                );
                return (
                  <div key={i} className={`px-3 py-2 rounded-lg border transition-all duration-300 flex items-center gap-3 ${isActive ? 'border-accent bg-accent/10 shadow-[0_0_10px_rgba(0,212,255,0.1)]' : 'border-border bg-white/5 opacity-40'}`}>
                    <span className={`font-mono text-[10px] ${isActive ? 'text-accent' : 'text-t3'}`}>0{i+1}</span>
                    <span className={`font-syne font-bold text-[11px] ${isActive ? 'text-t1' : 'text-t2'}`}>{step}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </aside>
      </section>

      {/* Scroll Indicator */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 pointer-events-none">
        <span className="font-mono text-[10px] text-t3 uppercase tracking-widest">Explore the Theory</span>
        <ChevronDown className="w-5 h-5 text-accent animate-bounce-y" />
      </div>

      {/* Theory Section */}
      <section className="bg-bg2 py-24 px-6">
        <div className="max-w-[900px] mx-auto">
          {/* Block 1 */}
          <div className="card-theory">
            <div className="flex gap-6">
              <div className="w-12 h-12 rounded-full bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0 shadow-[0_0_15px_rgba(0,212,255,0.1)]">
                <MapIcon className="w-6 h-6 text-accent" />
              </div>
              <div className="space-y-4">
                <h2 className="font-syne font-extrabold text-3xl">What is Map Coloring?</h2>
                <p className="text-t2 leading-relaxed">
                  Map coloring is the mathematical problem of assigning colors to regions of a map such that no two <span className="text-accent font-semibold">adjacent regions</span> share the same color. Adjacent means they share a border—not just a single point. This concept dates back to the 1850s and led to one of the most famous theorems in mathematics.
                </p>
                <div className="p-6 glass rounded-xl flex justify-center">
                  <svg width="200" height="120" viewBox="0 0 200 120">
                    <rect x="10" y="10" width="90" height="50" fill={COLORS[0]} stroke="#fff" strokeWidth="2" />
                    <rect x="100" y="10" width="90" height="50" fill={COLORS[1]} stroke="#fff" strokeWidth="2" />
                    <rect x="10" y="60" width="90" height="50" fill={COLORS[2]} stroke="#fff" strokeWidth="2" />
                    <rect x="100" y="60" width="90" height="50" fill={COLORS[3]} stroke="#fff" strokeWidth="2" />
                    <text x="55" y="40" fill="#000" fontSize="10" textAnchor="middle" fontWeight="bold">A</text>
                    <text x="145" y="40" fill="#000" fontSize="10" textAnchor="middle" fontWeight="bold">B</text>
                    <text x="55" y="90" fill="#000" fontSize="10" textAnchor="middle" fontWeight="bold">C</text>
                    <text x="145" y="90" fill="#000" fontSize="10" textAnchor="middle" fontWeight="bold">D</text>
                  </svg>
                </div>
              </div>
            </div>
          </div>

          {/* Block 2 */}
          <div className="card-theory">
            <div className="flex gap-6">
              <div className="w-12 h-12 rounded-full bg-accent2/10 border border-accent2/20 flex items-center justify-center shrink-0">
                <Share2 className="w-6 h-6 text-accent2" />
              </div>
              <div className="space-y-4">
                <h2 className="font-syne font-extrabold text-3xl">The Graph Transformation</h2>
                <p className="text-t2 leading-relaxed">
                  Every map coloring problem can be transformed into a graph problem. This is the key insight that allows us to use computer science algorithms:
                </p>
                <ul className="space-y-2 font-mono text-sm text-t1">
                  <li className="flex items-center gap-3"><div className="w-1.5 h-1.5 rounded-full bg-accent" /> Each region becomes a <span className="text-accent">NODE</span> (vertex)</li>
                  <li className="flex items-center gap-3"><div className="w-1.5 h-1.5 rounded-full bg-accent" /> Each shared border becomes an <span className="text-accent">EDGE</span></li>
                  <li className="flex items-center gap-3"><div className="w-1.5 h-1.5 rounded-full bg-accent" /> Coloring the map = coloring the graph</li>
                </ul>
                <div className="flex items-center justify-center gap-12 p-8 glass rounded-xl">
                  <div className="text-center space-y-2">
                    <svg width="100" height="100" viewBox="0 0 100 100">
                      <rect x="10" y="10" width="40" height="40" fill={COLORS[0]} stroke="#fff" />
                      <rect x="50" y="10" width="40" height="40" fill={COLORS[1]} stroke="#fff" />
                      <rect x="10" y="50" width="40" height="40" fill={COLORS[2]} stroke="#fff" />
                      <rect x="50" y="50" width="40" height="40" fill={COLORS[3]} stroke="#fff" />
                    </svg>
                    <p className="text-[10px] font-mono text-t3">MAP</p>
                  </div>
                  <div className="text-accent text-2xl">→</div>
                  <div className="text-center space-y-2">
                    <svg width="100" height="100" viewBox="0 0 100 100">
                      <line x1="30" y1="30" x2="70" y2="30" stroke="rgba(255,255,255,0.2)" />
                      <line x1="30" y1="30" x2="30" y2="70" stroke="rgba(255,255,255,0.2)" />
                      <line x1="70" y1="70" x2="70" y2="30" stroke="rgba(255,255,255,0.2)" />
                      <line x1="70" y1="70" x2="30" y2="70" stroke="rgba(255,255,255,0.2)" />
                      <circle cx="30" cy="30" r="8" fill={COLORS[0]} />
                      <circle cx="70" cy="30" r="8" fill={COLORS[1]} />
                      <circle cx="30" cy="70" r="8" fill={COLORS[2]} />
                      <circle cx="70" cy="70" r="8" fill={COLORS[3]} />
                    </svg>
                    <p className="text-[10px] font-mono text-t3">GRAPH</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Block 4 */}
          <div className="card-theory">
            <div className="flex gap-6">
              <div className="w-12 h-12 rounded-full bg-yellow/10 border border-yellow/20 flex items-center justify-center shrink-0">
                <Target className="w-6 h-6 text-yellow" />
              </div>
              <div className="space-y-4 w-full">
                <h2 className="font-syne font-extrabold text-3xl">Constraint Satisfaction Problem (CSP)</h2>
                <p className="text-t2 leading-relaxed">
                  In AI, map coloring is a classic example of a CSP. It consists of variables, domains, and constraints.
                </p>
                <div className="overflow-hidden rounded-xl border border-border">
                  <table className="w-full font-mono text-xs text-left">
                    <thead className="bg-accent/10 text-accent">
                      <tr>
                        <th className="p-4 border-b border-border">CSP Component</th>
                        <th className="p-4 border-b border-border">Map Coloring Equivalent</th>
                      </tr>
                    </thead>
                    <tbody className="bg-black/20">
                      <tr>
                        <td className="p-4 border-b border-border text-t1">Variables</td>
                        <td className="p-4 border-b border-border text-t2">Regions / Countries</td>
                      </tr>
                      <tr>
                        <td className="p-4 border-b border-border text-t1">Domain</td>
                        <td className="p-4 border-b border-border text-t2">Set of colors {'{R, G, B, Y}'}</td>
                      </tr>
                      <tr>
                        <td className="p-4 border-b border-border text-t1">Constraints</td>
                        <td className="p-4 border-b border-border text-t2">Adjacent ≠ same color</td>
                      </tr>
                      <tr>
                        <td className="p-4 text-t1">Solution</td>
                        <td className="p-4 text-t2">Complete valid assignment</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>

          {/* Block 5 */}
          <div className="card-theory">
            <div className="flex gap-6">
              <div className="w-12 h-12 rounded-full bg-green/10 border border-green/20 flex items-center justify-center shrink-0">
                <Play className="w-6 h-6 text-green fill-current" />
              </div>
              <div className="space-y-4 w-full">
                <h2 className="font-syne font-extrabold text-3xl">The Backtracking Algorithm</h2>
                <p className="text-t2 leading-relaxed">
                  Backtracking is a depth-first search that builds a solution incrementally and abandons a path ("backtracks") as soon as it determines the path cannot lead to a valid solution.
                </p>
                <div className="p-6 bg-[#0a0f1e] rounded-xl border-l-4 border-accent font-mono text-xs leading-relaxed overflow-x-auto">
                  <div className="flex gap-4">
                    <div className="text-t3 text-right select-none">
                      01<br/>02<br/>03<br/>04<br/>05<br/>06<br/>07<br/>08<br/>09<br/>10<br/>11<br/>12<br/>13<br/>14
                    </div>
                    <div className="text-t2">
                      <span className="text-accent">function</span> <span className="text-yellow">BACKTRACK</span>(assignment, regions):<br/>
                      &nbsp;&nbsp;<span className="text-accent">if</span> all regions assigned:<br/>
                      &nbsp;&nbsp;&nbsp;&nbsp;<span className="text-accent">return</span> <span className="text-green">SUCCESS</span> ✓<br/><br/>
                      &nbsp;&nbsp;region = <span className="text-yellow">selectMRV</span>(regions)<br/><br/>
                      &nbsp;&nbsp;<span className="text-accent">for each</span> color <span className="text-accent">in</span> PALETTE:<br/>
                      &nbsp;&nbsp;&nbsp;&nbsp;<span className="text-accent">if</span> <span className="text-yellow">isValid</span>(region, color, assignment):<br/>
                      &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;assignment[region] = color<br/>
                      &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;result = <span className="text-yellow">BACKTRACK</span>(assignment, regions)<br/>
                      &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="text-accent">if</span> result ≠ FAILURE:<br/>
                      &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="text-accent">return</span> result<br/>
                      &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;assignment[region] = <span className="text-accent">null</span> <span className="text-t3">// Undo</span><br/><br/>
                      &nbsp;&nbsp;<span className="text-accent">return</span> <span className="text-red">FAILURE</span> ✗
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Block 6 */}
          <div className="card-theory">
            <div className="flex gap-6">
              <div className="w-12 h-12 rounded-full bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
                <CheckCircle2 className="w-6 h-6 text-accent" />
              </div>
              <div className="space-y-4">
                <h2 className="font-syne font-extrabold text-3xl">The Four Color Theorem</h2>
                <h4 className="font-mono text-xs text-t3 uppercase tracking-widest">One of mathematics' greatest achievements</h4>
                <p className="text-t2 leading-relaxed">
                  "Every planar map can be colored using at most 4 colors such that no two adjacent regions share the same color." Conjectured in 1852 by Francis Guthrie, it was finally proved in 1976 by Appel and Haken using computer assistance—the first major theorem proved by computer.
                </p>
                <div className="flex gap-4 p-6 glass rounded-xl justify-center">
                  {COLORS.slice(0, 4).map((c, i) => (
                    <div key={i} className="flex flex-col items-center gap-2">
                      <div className="w-12 h-12 rounded-full shadow-[0_0_15px_rgba(255,255,255,0.1)]" style={{ backgroundColor: c }} />
                      <span className="font-mono text-[8px] text-t3">COLOR {i+1}</span>
                    </div>
                  ))}
                </div>
                <p className="text-center font-syne font-bold text-accent italic">"4 is always enough"</p>
              </div>
            </div>
          </div>

          {/* Block 7 */}
          <div className="card-theory">
            <div className="flex gap-6">
              <div className="w-12 h-12 rounded-full bg-purple-600/10 border border-purple-600/20 flex items-center justify-center shrink-0">
                <AlertCircle className="w-6 h-6 text-purple-500" />
              </div>
              <div className="space-y-4">
                <h2 className="font-syne font-extrabold text-3xl">Why Order Matters: MRV Heuristic</h2>
                <p className="text-t2 leading-relaxed">
                  Minimum Remaining Values (MRV)—always color the region with the fewest valid color options remaining. This dramatically reduces backtracking. If a region has only 1 valid color left, assign it NOW before it causes a failure later. The visualizer uses MRV ordering (most-connected regions first as a proxy).
                </p>
              </div>
            </div>
          </div>

          {/* Block 8 */}
          <div className="card-theory">
            <div className="flex gap-6">
              <div className="w-12 h-12 rounded-full bg-red/10 border border-red/20 flex items-center justify-center shrink-0">
                <Info className="w-6 h-6 text-red" />
              </div>
              <div className="space-y-4 w-full">
                <h2 className="font-syne font-extrabold text-3xl">Time Complexity</h2>
                <p className="text-t2 leading-relaxed">
                  Map coloring is NP-complete for k ≥ 3 colors. In the worst case, the complexity is <span className="font-mono text-accent">O(kⁿ)</span> where k is the number of colors and n is the number of regions. However, with heuristics like MRV and constraint propagation, real-world maps solve in milliseconds.
                </p>
                <div className="grid grid-cols-3 gap-4 font-mono text-[10px] text-center">
                  <div className="p-3 glass rounded-lg border-red/20">
                    <p className="text-red mb-1">Brute Force</p>
                    <p className="text-t1 text-lg">O(kⁿ)</p>
                  </div>
                  <div className="p-3 glass rounded-lg border-yellow/20">
                    <p className="text-yellow mb-1">Backtracking</p>
                    <p className="text-t1 text-lg">O(kⁿ)</p>
                    <p className="text-[8px] text-t3 opacity-50">(Pruned)</p>
                  </div>
                  <div className="p-3 glass rounded-lg border-green/20">
                    <p className="text-green mb-1">Backtracking + MRV</p>
                    <p className="text-t1 text-lg">O(kⁿ)</p>
                    <p className="text-[8px] text-t3 opacity-50">(Highly Pruned)</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <footer className="mt-24 pt-12 border-t border-border text-center space-y-4">
          <p className="font-mono text-xs text-t3">
            Built with 🌻 by <span className="text-accent">Varsha M</span> · AI Map Coloring Visualizer · Backtracking CSP
          </p>
          <div className="flex justify-center gap-6 opacity-30 grayscale hover:grayscale-0 transition-all duration-500">
             <div className="w-8 h-8 bg-accent rounded-md" />
             <div className="w-8 h-8 bg-accent2 rounded-md" />
             <div className="w-8 h-8 bg-purple-600 rounded-md" />
          </div>
        </footer>
      </section>
    </div>
  );
}
