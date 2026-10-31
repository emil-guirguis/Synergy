import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import LoginIcon from '@mui/icons-material/Login';
import logo from '../assets/meteritpro-logo.svg';
import { useAuth } from '../hooks/useAuth';
import './LandingPage.css';

const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
        {
            "@type": "Question",
            "name": "What is meter management software?",
            "acceptedAnswer": { "@type": "Answer", "text": "Meter management software is a platform that automates the collection, validation, storage, and reporting of meter readings across one or more sites. It replaces manual spreadsheets and paper logs with a centralised system that tracks electrical, water, gas, or submetering devices, flags anomalies, and generates audit-ready reports." }
        },
        {
            "@type": "Question",
            "name": "Who is MeterIt Pro designed for?",
            "acceptedAnswer": { "@type": "Answer", "text": "MeterIt Pro is designed for meter manufacturers, meter sellers and distributors, building management system (BMS) operators, utilities, energy service companies (ESCOs), energy consultants, and property and facility managers." }
        },
        {
            "@type": "Question",
            "name": "Can meter manufacturers use MeterIt Pro as part of their product offering?",
            "acceptedAnswer": { "@type": "Answer", "text": "Yes. MeterIt Pro is built to support OEM and white-label deployments. Meter manufacturers can offer MeterIt Pro as a software layer on top of their hardware, giving customers a complete meter data management platform out of the box." }
        },
        {
            "@type": "Question",
            "name": "Does MeterIt Pro integrate with BMS systems?",
            "acceptedAnswer": { "@type": "Answer", "text": "Yes. MeterIt Pro can ingest meter data from building management systems and export validated data back to BMS platforms, with automated validation and reporting." }
        },
        {
            "@type": "Question",
            "name": "What types of meters does MeterIt Pro support?",
            "acceptedAnswer": { "@type": "Answer", "text": "MeterIt Pro supports electrical meters, submeters, and any device-based meter register. The platform handles multi-register meters and supports custom device configurations for different meter types and manufacturers." }
        },
        {
            "@type": "Question",
            "name": "Can MeterIt Pro handle multiple sites and tenants?",
            "acceptedAnswer": { "@type": "Answer", "text": "Yes. MeterIt Pro is built for multi-site and multi-tenant deployments. You can manage meter readings across hundreds of locations from a single dashboard, with per-tenant data isolation and role-based access control." }
        },
        {
            "@type": "Question",
            "name": "Is there a free plan or trial?",
            "acceptedAnswer": { "@type": "Answer", "text": "Yes. MeterIt Pro offers a Starter plan for small portfolios and single-site operators. Contact us or sign up directly to get started. For larger deployments, book a demo and we will tailor a plan to your needs." }
        }
    ]
};

const orgSchema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "MeterIt Pro",
    "url": "https://meteritpro.com",
    "logo": "https://meteritpro.com/og-image.png",
    "contactPoint": {
        "@type": "ContactPoint",
        "email": "demo@meteritpro.com",
        "contactType": "sales"
    }
};

const LandingPage: React.FC = () => {
    const { isAuthenticated, isLoading } = useAuth();
    const navigate = useNavigate();

    const [dropdownOpen, setDropdownOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

    const [demoForm, setDemoForm] = useState({ name: '', email: '', company: '', message: '' });
    const [demoSent, setDemoSent] = useState(false);

    const [showStickyBar, setShowStickyBar] = useState(false);
    const heroRef = useRef<HTMLElement>(null);

    useEffect(() => {
        if (!isLoading && isAuthenticated) {
            navigate('/home', { replace: true });
        }
    }, [isAuthenticated, isLoading, navigate]);

    // Close dropdown on outside click
    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, []);

    // Show sticky CTA bar once the hero scrolls out of view
    useEffect(() => {
        const hero = heroRef.current;
        if (!hero) return;
        const observer = new IntersectionObserver(
            ([entry]) => setShowStickyBar(!entry.isIntersecting),
            { threshold: 0 }
        );
        observer.observe(hero);
        return () => observer.disconnect();
    }, []);

    const handleDropdownKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            setDropdownOpen(false);
            (dropdownRef.current?.querySelector('button') as HTMLButtonElement)?.focus();
        }
    };

    const handleDemoSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const subject = encodeURIComponent(`Demo request from ${demoForm.name}${demoForm.company ? ` at ${demoForm.company}` : ''}`);
        const body = encodeURIComponent(
            `Name: ${demoForm.name}\nCompany: ${demoForm.company}\nEmail: ${demoForm.email}\n\n${demoForm.message}`
        );
        window.location.href = `mailto:demo@meteritpro.com?subject=${subject}&body=${body}`;
        setDemoSent(true);
    };

    return (
        <div className="landing-page">
            <Helmet>
                <title>MeterIt Pro — Meter Management Software for BMS, Manufacturers &amp; Utilities</title>
                <meta name="description" content="MeterIt Pro is cloud-based meter management software for meter sellers, manufacturers, utilities, and BMS operators. Automate readings, validate data, and report across every site." />
                <meta name="keywords" content="meter management software, meter reading software, BMS software, building management system, submetering software, energy meter tracking, meter data management, utility meter software, meter manufacturer software, OEM meter platform" />
                <link rel="canonical" href="https://meteritpro.com/" />
                <meta property="og:title" content="MeterIt Pro — Meter Management Software" />
                <meta property="og:description" content="Cloud-based meter data management for meter sellers, manufacturers, utilities, and BMS operators. Automate readings, validate data, get reports." />
                <meta property="og:url" content="https://meteritpro.com/" />
                <meta property="og:type" content="website" />
                <meta name="twitter:title" content="MeterIt Pro — Meter Management Software" />
                <meta name="twitter:description" content="Cloud-based meter data management for meter sellers, manufacturers, utilities, and BMS operators." />
                <script type="application/ld+json">{JSON.stringify(faqSchema)}</script>
                <script type="application/ld+json">{JSON.stringify(orgSchema)}</script>
            </Helmet>

            <header className="landing-nav">
                <div className="landing-nav-inner">
                    <div className="landing-logo">
                        <img src={logo} alt="MeterIt Pro logo" />
                        <span>MeterIt Pro</span>
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
                            onKeyDown={handleDropdownKeyDown}
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
                                <a href="#products" role="menuitem" onClick={() => setDropdownOpen(false)}>Smart Meter Capture</a>
                                <a href="#products" role="menuitem" onClick={() => setDropdownOpen(false)}>Audit Trails</a>
                                <a href="#products" role="menuitem" onClick={() => setDropdownOpen(false)}>Alerts &amp; Analytics</a>
                            </div>
                        </div>
                        <a href="#pricing">Pricing</a>
                        <a href="#partners">Partners</a>
                        <a href="#demo">Demo</a>
                        <Link to="/support">Support</Link>
                        <a href="#contact">Contact</a>
                        <Link className="landing-login" to="/login">
                            <LoginIcon fontSize="small" />
                            Login
                        </Link>
                    </nav>
                </div>
            </header>

            {mobileMenuOpen && (
                <nav className="landing-mobile-menu" role="dialog" aria-modal="true" aria-label="Mobile navigation">
                    <a href="#products" onClick={() => setMobileMenuOpen(false)}>Products</a>
                    <a href="#pricing" onClick={() => setMobileMenuOpen(false)}>Pricing</a>
                    <a href="#partners" onClick={() => setMobileMenuOpen(false)}>Partners</a>
                    <a href="#demo" onClick={() => setMobileMenuOpen(false)}>Demo</a>
                    <Link to="/support" onClick={() => setMobileMenuOpen(false)}>Support</Link>
                    <a href="#contact" onClick={() => setMobileMenuOpen(false)}>Contact</a>
                    <Link className="landing-login landing-mobile-login" to="/login" onClick={() => setMobileMenuOpen(false)}>
                        <LoginIcon fontSize="small" />
                        Login
                    </Link>
                </nav>
            )}

            <section className="landing-hero" id="top" ref={heroRef}>
                <div>
                    <div className="landing-hero-badges">
                        <span className="landing-badge landing-badge--blue">Pilot-ready</span>
                        <span className="landing-badge landing-badge--green">Multi-tenant</span>
                        <span className="landing-badge landing-badge--gray">OEM &amp; White-label</span>
                    </div>
                    <h1>Meter Management Software for Manufacturers, Sellers &amp; BMS Operators</h1>
                    <p>
                        MeterIt Pro is a cloud-based meter data management platform built for meter
                        manufacturers, resellers, utilities, and building management system (BMS) operators.
                        Automate meter readings, validate data, generate reports, and get AI-powered insights
                        across single sites or entire multi-site portfolios — all in one secure platform.
                    </p>
                    <div className="landing-hero-actions">
                        <a className="landing-btn-primary" href="#demo">Request a Demo</a>
                        <Link className="landing-btn-secondary" to="/login">Login</Link>
                        <a className="landing-btn-tertiary" href="#demo">See a quick live demo</a>
                    </div>
                </div>
                <div className="landing-hero-card">
                    <h3>What you get</h3>
                    <ul>
                        <li>Automated meter capture with audit-ready history</li>
                        <li>Automated validation and anomaly detection</li>
                        <li>Portfolio dashboards for energy and cost control</li>
                        <li>Customizable reporting &amp; export</li>
                        <li>AI-powered meter data querying</li>
                        <li>Multi-tenant &amp; multi-site support</li>
                    </ul>
                </div>
            </section>

            <section className="landing-section" id="products">
                <h2>Meter Management Software Built for the Whole Industry</h2>
                <p>
                    Whether you sell meters, manufacture them, manage buildings, or operate utilities —
                    MeterIt Pro keeps every electrical meter reading accurate, traceable, and easy to analyze.
                    Purpose-built submetering software with the flexibility to fit any portfolio.
                </p>
                <div className="landing-grid">
                    <div className="landing-card">
                        <h3>Smart Meter Capture</h3>
                        <p>Mobile-friendly workflows that guide technicians through every reading. Supports electrical, water, gas, and submetering devices.</p>
                    </div>
                    <div className="landing-card">
                        <h3>Validation &amp; Anomaly Detection</h3>
                        <p>Automatic quality checks flag anomalies and missing data before reports are sent — so your meter data is always audit-ready.</p>
                    </div>
                    <div className="landing-card">
                        <h3>Energy Analytics &amp; Reporting</h3>
                        <p>Track usage trends, peak demand, and cost efficiency across all meters. Export to PDF, CSV, or integrate with your BMS.</p>
                    </div>
                    <div className="landing-card">
                        <h3>Multi-Site Portfolio Management</h3>
                        <p>Manage meter readings across hundreds of locations from a single dashboard. Ideal for property managers, ESCOs, and meter manufacturers.</p>
                    </div>
                    <div className="landing-card">
                        <h3>Alerts &amp; Notifications</h3>
                        <p>Set threshold-based alerts for any meter register. Get notified instantly when readings fall outside expected ranges.</p>
                    </div>
                    <div className="landing-card">
                        <h3>AI-Ready Data Platform</h3>
                        <p>Query your meter data in plain language. MeterIt Pro is built for AI integration from day one.</p>
                    </div>
                </div>
            </section>

            <section className="landing-section landing-section--visibility" id="visibility">
                <div className="landing-visibility-content">
                    <div>
                        <span className="landing-badge landing-badge--blue landing-badge--section">Full Visibility &amp; Access Anywhere</span>
                        <h2>Your Meter Data. Any Device. Any Location.</h2>
                        <p>
                            MeterIt Pro is fully cloud-hosted — no on-premises servers, no VPN required.
                            Your entire meter portfolio is visible and manageable from any browser, on
                            any device, 24 hours a day.
                        </p>
                        <ul className="landing-visibility-list">
                            <li>Live dashboard updates — no manual refresh or data exports needed</li>
                            <li>Access from desktop, tablet, or mobile on any modern browser</li>
                            <li>Role-based access control — field technicians, managers, and clients each see only what they need</li>
                            <li>Secure, encrypted connections with tenant-level data isolation</li>
                            <li>Share read-only portfolio views with clients or stakeholders without giving full account access</li>
                        </ul>
                        <div className="landing-hero-actions landing-visibility-actions">
                            <a className="landing-btn-primary" href="#demo">See It In Action</a>
                            <a className="landing-btn-tertiary" href="#pricing">View Plans</a>
                        </div>
                    </div>
                    <div className="landing-visibility-stats">
                        <div className="landing-stat-card">
                            <span className="landing-stat-value">24/7</span>
                            <span className="landing-stat-label">Real-time access to all meter data</span>
                        </div>
                        <div className="landing-stat-card">
                            <span className="landing-stat-value">100%</span>
                            <span className="landing-stat-label">Cloud-hosted — zero on-premises setup</span>
                        </div>
                        <div className="landing-stat-card">
                            <span className="landing-stat-value">Multi-site</span>
                            <span className="landing-stat-label">Manage hundreds of locations from one dashboard</span>
                        </div>
                        <div className="landing-stat-card">
                            <span className="landing-stat-value">RBAC</span>
                            <span className="landing-stat-label">Granular role-based access per user and tenant</span>
                        </div>
                    </div>
                </div>
            </section>

            <section className="landing-section" id="who">
                <h2>Who Uses MeterIt Pro</h2>
                <p>
                    From OEM meter manufacturers embedding our platform in their product offering, to
                    utilities managing city-wide submetering, MeterIt Pro scales to every use case.
                </p>
                <div className="landing-grid">
                    <div className="landing-card">
                        <h3>Meter Manufacturers &amp; OEMs</h3>
                        <p>White-label or integrate MeterIt Pro into your product stack. Give your customers a full meter data management platform out of the box.</p>
                    </div>
                    <div className="landing-card">
                        <h3>Meter Sellers &amp; Distributors</h3>
                        <p>Add software value to every meter sale. Offer clients a managed platform for reading, reporting, and alerting.</p>
                    </div>
                    <div className="landing-card">
                        <h3>BMS &amp; Facilities Operators</h3>
                        <p>Connect your building management system to real meter data. Replace manual reads with automated capture and validation.</p>
                    </div>
                    <div className="landing-card">
                        <h3>Utilities &amp; ESCOs</h3>
                        <p>Manage submetering across large property portfolios. Deliver accurate billing data and energy reports to tenants.</p>
                    </div>
                    <div className="landing-card">
                        <h3>Energy Consultants</h3>
                        <p>Access clean, validated meter data for every client site. Generate professional reports without manual data wrangling.</p>
                    </div>
                    <div className="landing-card">
                        <h3>Property &amp; Facility Managers</h3>
                        <p>Track energy consumption across every unit and floor. Identify waste and allocate costs accurately.</p>
                    </div>
                </div>
            </section>

            <section className="landing-section landing-section--alt" id="testimonials">
                <h2>What Pilot Customers Say</h2>
                <p>Early partners across utilities, BMS, and meter manufacturing use MeterIt Pro to replace manual workflows and deliver real-time data to their clients.</p>
                {/* <div className="landing-testimonials">
                    <div className="landing-testimonial-card">
                        <blockquote className="landing-testimonial-quote">
                            "MeterIt Pro cut our manual meter reading time by over 60%. The multi-site dashboard is exactly what our field teams needed."
                        </blockquote>
                        <div className="landing-testimonial-author">
                            <div className="landing-testimonial-avatar" aria-hidden="true">OM</div>
                            <div>
                                <strong>Operations Manager</strong>
                                <span>Regional Utility — Pilot Customer</span>
                            </div>
                        </div>
                    </div>
                    <div className="landing-testimonial-card">
                        <blockquote className="landing-testimonial-quote">
                            "We embedded MeterIt Pro into our hardware platform in weeks. Our customers now have a full data management layer out of the box — without us building it from scratch."
                        </blockquote>
                        <div className="landing-testimonial-author">
                            <div className="landing-testimonial-avatar" aria-hidden="true">PD</div>
                            <div>
                                <strong>Product Director</strong>
                                <span>Meter Manufacturer — Pilot Partner</span>
                            </div>
                        </div>
                    </div>
                    <div className="landing-testimonial-card">
                        <blockquote className="landing-testimonial-quote">
                            "Finally a platform that speaks our language. Validation rules, threshold alerts, and clean exports — everything an energy consultant needs in one place."
                        </blockquote>
                        <div className="landing-testimonial-author">
                            <div className="landing-testimonial-avatar" aria-hidden="true">EC</div>
                            <div>
                                <strong>Senior Energy Consultant</strong>
                                <span>ESCOs &amp; Advisory — Pilot Customer</span>
                            </div>
                        </div>
                    </div>
                </div> */}
            </section>

            <section className="landing-section" id="pricing">
                <h2>Simple, Transparent Pricing</h2>
                <p>Start free and scale as your meter portfolio grows. No hidden fees.</p>
                <div className="landing-grid">
                    <Link to="/signup/starter" className="landing-card landing-pricing" style={{ textDecoration: 'none', cursor: 'pointer' }}>
                        <h3>Starter</h3>
                        <p>Perfect for small portfolios and single-site operators.</p>
                        <p><strong>$???? / month</strong></p>
                        <button type="button" className="landing-pricing-btn">Get Started</button>
                    </Link>
                    <Link to="/signup/growth" className="landing-card landing-pricing" style={{ textDecoration: 'none', cursor: 'pointer' }}>
                        <h3>Growth</h3>
                        <p>Scale across multiple locations with advanced reporting and multi-site meter management.</p>
                        <p><strong>$???? / month</strong></p>
                        <button type="button" className="landing-pricing-btn">Get Started</button>
                    </Link>
                    <Link to="/signup/enterprise" className="landing-card landing-pricing" style={{ textDecoration: 'none', cursor: 'pointer' }}>
                        <h3>Enterprise</h3>
                        <p>Custom integrations for meter manufacturers, large utilities, and OEM deployments.</p>
                        <p><strong>Contact us for pricing</strong></p>
                        <button type="button" className="landing-pricing-btn">Contact Us</button>
                    </Link>
                </div>
            </section>

            <section className="landing-section" id="partners">
                <h2>Trusted Across the Meter Industry</h2>
                <p>
                    Meter manufacturers, energy consultants, utilities, and BMS operators rely on
                    MeterIt Pro to deliver accurate meter data and actionable insights at every scale.
                </p>
                <div className="landing-partners-logos">
                    <div className="landing-partner-logo" aria-label="Meter Manufacturers &amp; OEMs">Meter Manufacturers &amp; OEMs</div>
                    <div className="landing-partner-logo" aria-label="Meter Sellers &amp; Distributors">Meter Sellers &amp; Distributors</div>
                    <div className="landing-partner-logo" aria-label="Utilities &amp; ESCOs">Utilities &amp; ESCOs</div>
                    <div className="landing-partner-logo" aria-label="BMS &amp; Facilities Teams">BMS &amp; Facilities Teams</div>
                    <div className="landing-partner-logo" aria-label="Energy Consultants">Energy Consultants</div>
                    <div className="landing-partner-logo" aria-label="Property Managers">Property Managers</div>
                </div>
                <p className="landing-partners-note">
                    Logos coming soon — we are onboarding pilot partners across utilities and BMS verticals.
                    <a href="#demo"> Contact us to join the pilot program.</a>
                </p>
            </section>

            <section className="landing-section" id="faq">
                <h2>Frequently Asked Questions</h2>
                <div className="landing-faq">
                    <details className="landing-faq-item">
                        <summary>What is meter management software?</summary>
                        <p>Meter management software is a platform that automates the collection, validation, storage, and reporting of meter readings across one or more sites. It replaces manual spreadsheets and paper logs with a centralised system that tracks electrical, water, gas, or submetering devices, flags anomalies, and generates audit-ready reports.</p>
                    </details>
                    <details className="landing-faq-item">
                        <summary>Who is MeterIt Pro designed for?</summary>
                        <p>MeterIt Pro is designed for meter manufacturers, meter sellers and distributors, building management system (BMS) operators, utilities, energy service companies (ESCOs), energy consultants, and property and facility managers. Essentially anyone who needs to collect, validate, or report on meter data across one or many sites.</p>
                    </details>
                    <details className="landing-faq-item">
                        <summary>Can meter manufacturers use MeterIt Pro as part of their product offering?</summary>
                        <p>Yes. MeterIt Pro is built to support OEM and white-label deployments. Meter manufacturers can offer MeterIt Pro as a software layer on top of their hardware, giving customers a complete meter data management platform out of the box — without building it from scratch.</p>
                    </details>
                    <details className="landing-faq-item">
                        <summary>Does MeterIt Pro integrate with BMS systems?</summary>
                        <p>Yes. MeterIt Pro can ingest meter data from building management systems and export validated data back to BMS platforms. It is designed to sit alongside or replace manual BMS meter reading workflows, with automated validation and reporting.</p>
                    </details>
                    <details className="landing-faq-item">
                        <summary>What types of meters does MeterIt Pro support?</summary>
                        <p>MeterIt Pro supports electrical meters, submeters, and any device-based meter register. The platform is designed to handle multi-register meters and supports custom device configurations for different meter types and manufacturers.</p>
                    </details>
                    <details className="landing-faq-item">
                        <summary>Can MeterIt Pro handle multiple sites and tenants?</summary>
                        <p>Yes. MeterIt Pro is built for multi-site and multi-tenant deployments. You can manage meter readings across hundreds of locations from a single dashboard, with per-tenant data isolation and role-based access control.</p>
                    </details>
                    <details className="landing-faq-item">
                        <summary>Is there a free plan or trial?</summary>
                        <p>Yes. MeterIt Pro offers a Starter plan for small portfolios and single-site operators. Contact us or sign up directly to get started. For larger deployments, book a demo and we will tailor a plan to your needs.</p>
                    </details>
                </div>
            </section>

            <section className="landing-section landing-section--alt" id="demo">
                <h2>Book a Demo</h2>
                <p>
                    See MeterIt Pro in action and learn how it can streamline meter data operations
                    for your meters, your sites, and your team.
                </p>
                {demoSent ? (
                    <div className="landing-demo-sent">
                        <strong>Thanks — your demo request is on its way.</strong>
                        <p>We will be in touch within one business day to arrange a time that works for you.</p>
                    </div>
                ) : (
                    <form className="landing-demo-form" onSubmit={handleDemoSubmit} noValidate>
                        <div className="landing-demo-form-row">
                            <label htmlFor="demo-name">
                                Name <span aria-hidden="true">*</span>
                                <input
                                    id="demo-name"
                                    type="text"
                                    required
                                    autoComplete="name"
                                    placeholder="Your name"
                                    value={demoForm.name}
                                    onChange={e => setDemoForm(f => ({ ...f, name: e.target.value }))}
                                />
                            </label>
                            <label htmlFor="demo-email">
                                Email <span aria-hidden="true">*</span>
                                <input
                                    id="demo-email"
                                    type="email"
                                    required
                                    autoComplete="email"
                                    placeholder="you@company.com"
                                    value={demoForm.email}
                                    onChange={e => setDemoForm(f => ({ ...f, email: e.target.value }))}
                                />
                            </label>
                        </div>
                        <label htmlFor="demo-company">
                            Company
                            <input
                                id="demo-company"
                                type="text"
                                autoComplete="organization"
                                placeholder="Your company name"
                                value={demoForm.company}
                                onChange={e => setDemoForm(f => ({ ...f, company: e.target.value }))}
                            />
                        </label>
                        <label htmlFor="demo-message">
                            What are you trying to solve?
                            <textarea
                                id="demo-message"
                                rows={4}
                                placeholder="Tell us about your meter portfolio, use case, or any specific questions."
                                value={demoForm.message}
                                onChange={e => setDemoForm(f => ({ ...f, message: e.target.value }))}
                            />
                        </label>
                        <div className="landing-hero-actions">
                            <button type="submit" className="landing-btn-primary">Request a Demo</button>
                            <Link className="landing-btn-secondary" to="/login">Go to Login</Link>
                        </div>
                    </form>
                )}
            </section>

            <section className="landing-section landing-section--alt" id="support">
                <h2>Support</h2>
                <p>Need help with MeterIt Pro? Our support team is here to help you get the most out of your meter data platform.</p>
                <div className="landing-contact-grid">
                    <div className="landing-contact-card">
                        <h3>Documentation</h3>
                        <p>Browse guides, API references, and step-by-step tutorials for setting up and using MeterIt Pro.</p>
                        <a className="landing-btn-tertiary" href="mailto:support@meteritpro.com">View Docs</a>
                    </div>
                    <div className="landing-contact-card">
                        <h3>Submit a Ticket</h3>
                        <p>Report a bug, request a feature, or get help with a specific issue. We respond within one business day.</p>
                        <a className="landing-btn-tertiary" href="mailto:support@meteritpro.com">support@meteritpro.com</a>
                    </div>
                    <div className="landing-contact-card">
                        <h3>Account Support</h3>
                        <p>Already a customer? Log in to access your account, manage users, and view your meter portfolio.</p>
                        <Link className="landing-btn-primary" to="/login">
                            <LoginIcon fontSize="small" style={{ verticalAlign: 'middle', marginRight: 4 }} />
                            Login
                        </Link>
                    </div>
                </div>
            </section>

            <section className="landing-section" id="contact">
                <h2>Contact Us</h2>
                <p>Have a question about MeterIt Pro, or want to explore a pilot or partnership? Get in touch and we will respond within one business day.</p>
                <div className="landing-contact-grid">
                    <div className="landing-contact-card">
                        <h3>Sales &amp; Demos</h3>
                        <p>Ready to see MeterIt Pro in action? Request a personalised demo for your team.</p>
                        <a className="landing-btn-primary" href="#demo">Request a Demo</a>
                    </div>
                    <div className="landing-contact-card">
                        <h3>General Enquiries</h3>
                        <p>Questions about pricing, integrations, or partnerships? Email us directly.</p>
                        <a className="landing-btn-tertiary" href="mailto:info@meteritpro.com">info@meteritpro.com</a>
                    </div>
                    <div className="landing-contact-card">
                        <h3>Pilot Program</h3>
                        <p>Join our pilot program and be among the first to shape the platform with your real-world use case.</p>
                        <a className="landing-btn-tertiary" href="mailto:pilot@meteritpro.com">pilot@meteritpro.com</a>
                    </div>
                </div>
            </section>

            <footer className="landing-footer">
                <a className="landing-back-to-top" href="#top">Back to top</a>
                © {new Date().getFullYear()} MeterIt Pro. All rights reserved.
            </footer>

            <div className={`landing-sticky-bar${showStickyBar ? ' landing-sticky-bar--visible' : ''}`} aria-hidden={!showStickyBar}>
                <span>Ready to see MeterIt Pro in action?</span>
                <a className="landing-btn-primary" href="#demo">Request a Demo</a>
                <a className="landing-sticky-bar-dismiss" href="#top" aria-label="Back to top">↑ Top</a>
            </div>
        </div>
    );
};

export default LandingPage;
