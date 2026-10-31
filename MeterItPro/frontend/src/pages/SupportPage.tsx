import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import LoginIcon from '@mui/icons-material/Login';
import logo from '../assets/meteritpro-logo.svg';
import { useAuth } from '../hooks/useAuth';
import './LandingPage.css';

const SupportPage: React.FC = () => {
    const { isAuthenticated, isLoading } = useAuth();
    const navigate = useNavigate();
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isLoading && isAuthenticated) {
            navigate('/home', { replace: true });
        }
    }, [isAuthenticated, isLoading, navigate]);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, []);

    return (
        <div className="landing-page">
            <Helmet>
                <title>Support — MeterIt Pro</title>
                <meta name="description" content="Get help with MeterIt Pro. Browse documentation, submit a support ticket, or contact our team." />
                <link rel="canonical" href="https://meteritpro.com/support" />
            </Helmet>

            <header className="landing-nav">
                <div className="landing-nav-inner">
                    <div className="landing-logo">
                        <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none', color: 'inherit' }}>
                            <img src={logo} alt="MeterIt Pro logo" />
                            <span>MeterIt Pro</span>
                        </Link>
                    </div>
                    <button
                        className={`landing-hamburger${mobileMenuOpen ? ' landing-hamburger--open' : ''}`}
                        aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
                        aria-expanded={mobileMenuOpen}
                        onClick={() => setMobileMenuOpen(o => !o)}
                    >
                        <span />
                        <span />
                        <span />
                    </button>
                    <nav className="landing-nav-links">
                        <div
                            className="landing-dropdown"
                            ref={dropdownRef}
                        >
                            <button
                                type="button"
                                aria-haspopup="true"
                                aria-expanded={dropdownOpen}
                                onClick={() => setDropdownOpen(o => !o)}
                            >
                                Products
                            </button>
                            <div
                                className={`landing-dropdown-menu${dropdownOpen ? ' landing-dropdown-menu--open' : ''}`}
                                role="menu"
                                aria-hidden={!dropdownOpen}
                            >
                                <Link to="/#products" role="menuitem" onClick={() => setDropdownOpen(false)}>Smart Meter Capture</Link>
                                <Link to="/#products" role="menuitem" onClick={() => setDropdownOpen(false)}>Audit Trails</Link>
                                <Link to="/#products" role="menuitem" onClick={() => setDropdownOpen(false)}>Alerts &amp; Analytics</Link>
                            </div>
                        </div>
                        <Link to="/#pricing">Pricing</Link>
                        <Link to="/#partners">Partners</Link>
                        <Link to="/#demo">Demo</Link>
                        <Link to="/support" className="landing-nav-active">Support</Link>
                        <Link to="/#contact">Contact</Link>
                        <Link className="landing-login" to="/login">
                            <LoginIcon fontSize="small" />
                            Login
                        </Link>
                    </nav>
                </div>
            </header>

            {mobileMenuOpen && (
                <nav className="landing-mobile-menu" role="dialog" aria-modal="true" aria-label="Mobile navigation">
                    <Link to="/#products" onClick={() => setMobileMenuOpen(false)}>Products</Link>
                    <Link to="/#pricing" onClick={() => setMobileMenuOpen(false)}>Pricing</Link>
                    <Link to="/#partners" onClick={() => setMobileMenuOpen(false)}>Partners</Link>
                    <Link to="/#demo" onClick={() => setMobileMenuOpen(false)}>Demo</Link>
                    <Link to="/support" onClick={() => setMobileMenuOpen(false)}>Support</Link>
                    <Link to="/#contact" onClick={() => setMobileMenuOpen(false)}>Contact</Link>
                    <Link className="landing-login landing-mobile-login" to="/login" onClick={() => setMobileMenuOpen(false)}>
                        <LoginIcon fontSize="small" />
                        Login
                    </Link>
                </nav>
            )}

            <section className="landing-hero" id="support-hero">
                <div>
                    <div className="landing-hero-badges">
                        <span className="landing-badge landing-badge--blue">Help Center</span>
                        <span className="landing-badge landing-badge--green">1 Business Day Response</span>
                    </div>
                    <h1>MeterIt Pro Support</h1>
                    <p>
                        Browse our documentation, submit a support ticket, or contact our team directly.
                        Whether you are setting up for the first time or troubleshooting an issue, we are here to help.
                    </p>
                    <div className="landing-hero-actions">
<Link className="landing-btn-secondary" to="/login">
                            <LoginIcon fontSize="small" style={{ verticalAlign: 'middle', marginRight: 4 }} />
                            Login to Your Account
                        </Link>
                    </div>
                </div>
                <div className="landing-hero-card">
                    <h3>Quick Links</h3>
                    <ul>
                        <li><a href="#docs">How To</a></li>
                        <li><a href="#faq">Frequently Asked Questions</a></li>
                    </ul>
                </div>
            </section>

            <section className="landing-section" id="docs">
                <h2>How To</h2>
                <p>Everything you need to get started and get the most out of MeterIt Pro.</p>
                <div className="landing-grid">
                    <div className="landing-card">
                        <h3>Getting Started</h3>
                        <p>Set up your account, add your first site, and configure your meters. Step-by-step guide for new users.</p>
                        <a className="landing-btn-tertiary" href="mailto:support@meteritpro.com">View</a>
                    </div>
                    <div className="landing-card">
                        <h3>Meter Configuration</h3>
                        <p>Add and configure meters, device registers, and multi-register devices. Covers electrical, water, gas, and submeters.</p>
                        <a className="landing-btn-tertiary" href="mailto:support@meteritpro.com">View</a>
                    </div>
                    <div className="landing-card">
                        <h3>Reporting &amp; Exports</h3>
                        <p>Generate reports, schedule exports, and integrate meter data with your BMS or billing system.</p>
                        <a className="landing-btn-tertiary" href="mailto:support@meteritpro.com">View</a>
                    </div>
                    <div className="landing-card">
                        <h3>Alerts &amp; Notifications</h3>
                        <p>Configure threshold-based alerts, notification rules, and escalation workflows for your meter portfolio.</p>
                        <a className="landing-btn-tertiary" href="mailto:support@meteritpro.com">View</a>
                    </div>
                    <div className="landing-card">
                        <h3>API &amp; Integrations</h3>
                        <p>Integrate MeterIt Pro with your existing systems using the REST API. Covers authentication, endpoints, and examples.</p>
                        <a className="landing-btn-tertiary" href="mailto:support@meteritpro.com">View</a>
                    </div>
                </div>
            </section>

<section className="landing-section" id="faq">
                <h2>Frequently Asked Questions</h2>
                <div className="landing-faq">
                    <details className="landing-faq-item">
                        <summary>How do I reset my password?</summary>
                        <p>On the login page, click "Forgot Password" and enter your email address. You will receive a reset link within a few minutes. Check your spam folder if it does not arrive.</p>
                    </details>
                    <details className="landing-faq-item">
                        <summary>How do I add a new user to my account?</summary>
                        <p>Go to Settings &gt; Users and click "Invite User". Enter their email address and assign a role. They will receive an invitation email to set up their account.</p>
                    </details>
                    <details className="landing-faq-item">
                        <summary>How do I add a new meter or site?</summary>
                        <p>Navigate to the Meters section and click "Add Meter". You will be guided through selecting a location, configuring the device type, and setting up registers.</p>
                    </details>
                    <details className="landing-faq-item">
                        <summary>Can I export my meter data?</summary>
                        <p>Yes. Go to Reports and select the date range and meters you want to export. Data can be exported as CSV or PDF. Scheduled exports can also be configured.</p>
                    </details>
                    <details className="landing-faq-item">
                        <summary>What should I do if a meter reading looks wrong?</summary>
                        <p>MeterIt Pro flags anomalies automatically. If you see a flagged reading, you can review it in the Meter Readings section. Contact support if you believe there is a systematic issue with a device.</p>
                    </details>
                    <details className="landing-faq-item">
                        <summary>How do I upgrade or change my plan?</summary>
                        <p>Contact us at <a href="mailto:billing@meteritpro.com">billing@meteritpro.com</a> and we will update your plan. Self-serve plan management is coming soon.</p>
                    </details>
                </div>
            </section>

<footer className="landing-footer">
                <a className="landing-back-to-top" href="#support-hero">Back to top</a>
                © {new Date().getFullYear()} MeterIt Pro. All rights reserved.
            </footer>
        </div>
    );
};

export default SupportPage;
