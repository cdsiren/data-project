 Indication Monetization Strategy                                                                                                                                                       
                                                                                                                                                                                        
 Executive Summary                                                                                                                                                                      
                                                                                                                                                                                        
 Product: Real-time prediction market data infrastructure with sub-10ms trigger evaluation, multi-market abstraction, and arbitrage detection.                                          
                                                                                                                                                                                        
 Key Constraints:                                                                                                                                                                       
 - 4 paid tiers only (no free tier)                                                                                                                                                     
 - 100% self-serve (limited capacity for business support)                                                                                                                              
 - Immediate revenue: $5K MRR in month 1                                                                                                                                                
 - Year 1 target: $1.3M+ ARR                                                                                                                                                            
                                                                                                                                                                                        
 Strategy Grade Optimization:                                                                                                                                                           
 ┌──────────────────────┬───────┬────────────────────────────────────────────────────────────┐                                                                                          
 │      Criterion       │ Score │                         Rationale                          │                                                                                          
 ├──────────────────────┼───────┼────────────────────────────────────────────────────────────┤                                                                                          
 │ Monetizability       │ A+    │ No free tier = 100% paying users, high ARPU                │                                                                                          
 ├──────────────────────┼───────┼────────────────────────────────────────────────────────────┤                                                                                          
 │ Defensibility        │ A-    │ Latency moat, data flywheel, multi-market first-mover      │                                                                                          
 ├──────────────────────┼───────┼────────────────────────────────────────────────────────────┤                                                                                          
 │ Market Pull          │ A     │ Solves urgent arbitrage detection + data quality pain      │                                                                                          
 ├──────────────────────┼───────┼────────────────────────────────────────────────────────────┤                                                                                          
 │ Initial Applications │ A     │ Polymarket arb traders + bot developers = immediate demand │                                                                                          
 └──────────────────────┴───────┴────────────────────────────────────────────────────────────┘                                                                                          
 ---                                                                                                                                                                                    
 Core Network Effect: Market Relationship Graph                                                                                                                                         
                                                                                                                                                                                        
 The Flywheel                                                                                                                                                                           
                                                                                                                                                                                        
 Users register multi-market triggers                                                                                                                                                   
         ↓                                                                                                                                                                              
 System learns which markets are related                                                                                                                                                
         ↓                                                                                                                                                                              
 Better arb detection + search + recommendations                                                                                                                                        
         ↓                                                                                                                                                                              
 More users find value → register more markets                                                                                                                                          
         ↓                                                                                                                                                                              
 Graph becomes more valuable → moat deepens                                                                                                                                             
                                                                                                                                                                                        
 How It Works                                                                                                                                                                           
                                                                                                                                                                                        
 User Action: Register a multi-market arbitrage trigger                                                                                                                                 
 - "Alert me when Election Winner + Party Control markets diverge"                                                                                                                      
 - User explicitly links Market A ↔ Market B                                                                                                                                            
                                                                                                                                                                                        
 System Captures:                                                                                                                                                                       
 - Edge in graph: {market_a, market_b, relationship_type, user_count}                                                                                                                   
 - Correlation strength from orderbook data                                                                                                                                             
 - Co-movement patterns over time                                                                                                                                                       
                                                                                                                                                                                        
 Network Effect Benefits:                                                                                                                                                               
 1. Better Arb Detection - Proactively monitor related markets users haven't linked                                                                                                     
 2. Smart Recommendations - "Users tracking X also track Y" (85% add it)                                                                                                                
 3. Improved Search - "Show markets related to the election" uses graph                                                                                                                 
 4. Historical Analysis - Cluster analysis for backtesting strategies                                                                                                                   
 5. Data Quality - More linked markets = richer dataset for all users                                                                                                                   
                                                                                                                                                                                        
 Incentivizing Graph Growth                                                                                                                                                             
                                                                                                                                                                                        
 Multi-Market Triggers Are Discounted:                                                                                                                                                  
 - Single-market trigger: Standard rate                                                                                                                                                 
 - 2-market trigger: 10% discount on overage                                                                                                                                            
 - 3+ market trigger: 20% discount on overage                                                                                                                                           
                                                                                                                                                                                        
 Graph Contribution Rewards:                                                                                                                                                            
 - First user to link two markets: 1 week free Pro features                                                                                                                             
 - Links that get adopted by 10+ users: Badge + leaderboard recognition                                                                                                                 
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 Network Effect: Analysis Sharing Flywheel                                                                                                                                              
                                                                                                                                                                                        
 The Loop                                                                                                                                                                               
                                                                                                                                                                                        
 Users access historical data (Pro+)                                                                                                                                                    
         ↓                                                                                                                                                                              
 Create analyses (charts, correlations, insights)                                                                                                                                       
         ↓                                                                                                                                                                              
 Share on Twitter/Discord with "Made with Indication"                                                                                                                                   
         ↓                                                                                                                                                                              
 Viral reach attracts new users                                                                                                                                                         
         ↓                                                                                                                                                                              
 New users want same data access → subscribe                                                                                                                                            
         ↓                                                                                                                                                                              
 More analyses created → richer ecosystem                                                                                                                                               
                                                                                                                                                                                        
 Encouraging Analysis Sharing                                                                                                                                                           
                                                                                                                                                                                        
 Built-in Sharing Features:                                                                                                                                                             
 - One-click export charts with Indication branding                                                                                                                                     
 - Shareable analysis links (public read-only)                                                                                                                                          
 - Embed codes for blogs/newsletters                                                                                                                                                    
 - Twitter card optimization for shared links                                                                                                                                           
                                                                                                                                                                                        
 Analysis Contribution Rewards:                                                                                                                                                         
 ┌────────────────────────────────────┬───────────────────────────┐                                                                                                                     
 │               Action               │          Reward           │                                                                                                                     
 ├────────────────────────────────────┼───────────────────────────┤                                                                                                                     
 │ Share analysis with 100+ views     │ 5,000 free data rows      │                                                                                                                     
 ├────────────────────────────────────┼───────────────────────────┤                                                                                                                     
 │ Analysis featured in weekly digest │ 1 week Pro upgrade        │                                                                                                                     
 ├────────────────────────────────────┼───────────────────────────┤                                                                                                                     
 │ Analysis cited by 5+ other users   │ Permanent "Analyst" badge │                                                                                                                     
 ├────────────────────────────────────┼───────────────────────────┤                                                                                                                     
 │ Top analysis of the month          │ 1 month free Team tier    │                                                                                                                     
 └────────────────────────────────────┴───────────────────────────┘                                                                                                                     
 How Shared Analyses Feed the Product:                                                                                                                                                  
 1. Graph enrichment - Analyses often reveal market relationships                                                                                                                       
 2. Trigger templates - Popular analyses become pre-built trigger strategies                                                                                                            
 3. Search improvement - Analysis tags improve market discoverability                                                                                                                   
 4. Social proof - Quality analyses demonstrate platform value                                                                                                                          
                                                                                                                                                                                        
 Data Access Tiers (Designed for Sharing)                                                                                                                                               
 ┌──────────┬─────────────┬──────────────────┬────────────────────┐                                                                                                                     
 │   Tier   │ Data Window │      Export      │      Sharing       │                                                                                                                     
 ├──────────┼─────────────┼──────────────────┼────────────────────┤                                                                                                                     
 │ Starter  │ 7 days      │ None             │ Dashboard only     │                                                                                                                     
 ├──────────┼─────────────┼──────────────────┼────────────────────┤                                                                                                                     
 │ Pro      │ 90 days     │ Charts only      │ Shareable links    │                                                                                                                     
 ├──────────┼─────────────┼──────────────────┼────────────────────┤                                                                                                                     
 │ Team     │ 1 year      │ Full CSV/JSON    │ Embeds + API       │                                                                                                                     
 ├──────────┼─────────────┼──────────────────┼────────────────────┤                                                                                                                     
 │ Business │ Complete    │ Bulk + streaming │ White-label option │                                                                                                                     
 └──────────┴─────────────┴──────────────────┴────────────────────┘                                                                                                                     
 Why This Works:                                                                                                                                                                        
 - Pro users can share charts (viral marketing)                                                                                                                                         
 - Team users can export for deep analysis (power users)                                                                                                                                
 - Business users can build on top (platform play)                                                                                                                                      
 - All sharing drives awareness and graph growth                                                                                                                                        
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 Unified 4-Tier Pricing (Low Base + Usage Overage)                                                                                                                                      
                                                                                                                                                                                        
 Pricing Structure                                                                                                                                                                      
 ┌──────────┬────────────┬───────────────────┬──────────────┬─────────┐                                                                                                                 
 │   Tier   │ Base Price │ Included Requests │ Overage Rate │ Latency │                                                                                                                 
 ├──────────┼────────────┼───────────────────┼──────────────┼─────────┤                                                                                                                 
 │ Starter  │ $19/mo     │ 5,000/day         │ $0.002/req   │ 500ms   │                                                                                                                 
 ├──────────┼────────────┼───────────────────┼──────────────┼─────────┤                                                                                                                 
 │ Pro      │ $49/mo     │ 20,000/day        │ $0.0015/req  │ 100ms   │                                                                                                                 
 ├──────────┼────────────┼───────────────────┼──────────────┼─────────┤                                                                                                                 
 │ Team     │ $149/mo    │ 100,000/day       │ $0.001/req   │ 50ms    │                                                                                                                 
 ├──────────┼────────────┼───────────────────┼──────────────┼─────────┤                                                                                                                 
 │ Business │ $399/mo    │ 500,000/day       │ $0.0005/req  │ 20ms    │                                                                                                                 
 └──────────┴────────────┴───────────────────┴──────────────┴─────────┘                                                                                                                 
 Data Access & Compute Costs                                                                                                                                                            
 ┌──────────┬──────────────────┬──────────────────────────┬───────────────────┐                                                                                                         
 │   Tier   │ Historical Data  │     Backtest Access      │ Data Overage Rate │                                                                                                         
 ├──────────┼──────────────────┼──────────────────────────┼───────────────────┤                                                                                                         
 │ Starter  │ 7 days           │ None                     │ N/A               │                                                                                                         
 ├──────────┼──────────────────┼──────────────────────────┼───────────────────┤                                                                                                         
 │ Pro      │ 90 days          │ Read-only (no export)    │ $0.005/1K rows    │                                                                                                         
 ├──────────┼──────────────────┼──────────────────────────┼───────────────────┤                                                                                                         
 │ Team     │ 1 year           │ Full + Export            │ $0.003/1K rows    │                                                                                                         
 ├──────────┼──────────────────┼──────────────────────────┼───────────────────┤                                                                                                         
 │ Business │ Complete archive │ Full + Bulk Export + API │ $0.001/1K rows    │                                                                                                         
 └──────────┴──────────────────┴──────────────────────────┴───────────────────┘                                                                                                         
 Data overage applies to historical queries beyond included limits. Encourages efficient queries and analysis sharing.                                                                  
                                                                                                                                                                                        
 Expected Revenue Per User                                                                                                                                                              
 ┌──────────┬──────┬─────────────┬──────────────┬────────────┐                                                                                                                          
 │   Tier   │ Base │ API Overage │ Data Overage │ Total ARPU │                                                                                                                          
 ├──────────┼──────┼─────────────┼──────────────┼────────────┤                                                                                                                          
 │ Starter  │ $19  │ $12         │ $0           │ $31/mo     │                                                                                                                          
 ├──────────┼──────┼─────────────┼──────────────┼────────────┤                                                                                                                          
 │ Pro      │ $49  │ $30         │ $20          │ $109/mo     │                                                                                                                          
 ├──────────┼──────┼─────────────┼──────────────┼────────────┤                                                                                                                          
 │ Team     │ $149 │ $60         │ $45          │ $304/mo    │                                                                                                                          
 ├──────────┼──────┼─────────────┼──────────────┼────────────┤                                                                                                                          
 │ Business │ $499 │ $120        │ $80          │ $699/mo    │                                                                                                                          
 └──────────┴──────┴─────────────┴──────────────┴────────────┘                                                                                                                          
 Blended ARPU: $105/mo (base + API overage + data overage)                                                                                                                              
                                                                                                                                                                                        
 Feature Matrix                                                                                                                                                                         
 ┌──────────────────────┬─────────────┬────────────────┬───────────────┬────────────────┐                                                                                               
 │       Feature        │   Starter   │      Pro       │     Team      │    Business    │                                                                                               
 ├──────────────────────┼─────────────┼────────────────┼───────────────┼────────────────┤                                                                                               
 │ Dashboard Access     │ Full        │ Full           │ Full          │ Full           │                                                                                               
 ├──────────────────────┼─────────────┼────────────────┼───────────────┼────────────────┤                                                                                               
 │ API Access           │ Basic       │ Full           │ Full          │ Full           │                                                                                               
 ├──────────────────────┼─────────────┼────────────────┼───────────────┼────────────────┤                                                                                               
 │ Historical Data      │ 7 days      │ 90 days        │ 1 year        │ Complete       │                                                                                               
 ├──────────────────────┼─────────────┼────────────────┼───────────────┼────────────────┤                                                                                               
 │ Backtesting          │ None        │ Read-only      │ Full + Export │ Bulk + API     │                                                                                               
 ├──────────────────────┼─────────────┼────────────────┼───────────────┼────────────────┤                                                                                               
 │ Price Triggers       │ Yes         │ Yes            │ Yes           │ Yes            │                                                                                               
 ├──────────────────────┼─────────────┼────────────────┼───────────────┼────────────────┤                                                                                               
 │ Spread Triggers      │ Yes         │ Yes            │ Yes           │ Yes            │                                                                                               
 ├──────────────────────┼─────────────┼────────────────┼───────────────┼────────────────┤                                                                                               
 │ Imbalance Triggers   │ No          │ Yes            │ Yes           │ Yes            │                                                                                               
 ├──────────────────────┼─────────────┼────────────────┼───────────────┼────────────────┤                                                                                               
 │ YES/NO Arb Detection │ No          │ Yes            │ Yes           │ Yes            │                                                                                               
 ├──────────────────────┼─────────────┼────────────────┼───────────────┼────────────────┤                                                                                               
 │ Multi-Market Arb     │ No          │ No             │ Yes           │ Yes            │                                                                                               
 ├──────────────────────┼─────────────┼────────────────┼───────────────┼────────────────┤                                                                                               
 │ HFT Signals          │ No          │ No             │ Yes           │ Yes            │                                                                                               
 ├──────────────────────┼─────────────┼────────────────┼───────────────┼────────────────┤                                                                                               
 │ Whale Tracking       │ No          │ No             │ Yes           │ Yes            │                                                                                               
 ├──────────────────────┼─────────────┼────────────────┼───────────────┼────────────────┤                                                                                               
 │ Custom Triggers      │ No          │ No             │ No            │ Yes            │                                                                                               
 ├──────────────────────┼─────────────┼────────────────┼───────────────┼────────────────┤                                                                                               
 │ Market Graph Access  │ View        │ View + Suggest │ Full          │ Full + Export  │                                                                                               
 ├──────────────────────┼─────────────┼────────────────┼───────────────┼────────────────┤                                                                                               
 │ Webhook Delivery     │ Best-effort │ 99% SLA        │ 99.5% SLA     │ 99.9% SLA      │                                                                                               
 ├──────────────────────┼─────────────┼────────────────┼───────────────┼────────────────┤                                                                                            
 │ Dedicated Shared     │ N/A         │ N/A            │ N/A           │ Yes      │                                                                                               
 ├──────────────────────┼─────────────┼────────────────┼───────────────┼────────────────┤                                                                                               
 │ Support              │ Email (48h) │ Email (24h)    │ Slack         │ Priority Slack │                                                                                               
 └──────────────────────┴─────────────┴────────────────┴───────────────┴────────────────┘                                                                                               
 Why This Pricing Maximizes Revenue                                                                                                                                                     
                                                                                                                                                                                        
 Low Base = High Conversion:                                                                                                                                                            
 - $19 entry removes friction (coffee money)                                                                                                                                            
 - Credit card on file from day 1                                                                                                                                                       
 - 7-day trial still shows Pro features                                                                                                                                                 
                                                                                                                                                                                        
 Overage = Revenue Expansion:                                                                                                                                                           
 - Active users naturally exceed limits                                                                                                                                                 
 - Per-request billing aligns cost with value                                                                                                                                           
 - No hard walls → smooth UX, more usage                                                                                                                                                
 - Predictable for users (can set spend caps)                                                                                                                                           
                                                                                                                                                                                        
 No Seat-Based Pricing:                                                                                                                                                                 
 - Teams share one account                                                                                                                                                              
 - Overage naturally scales with team size                                                                                                                                              
 - Simpler pricing = easier to buy                                                                                                                                                      
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 Value Proposition by Audience                                                                                                                                                          
                                                                                                                                                                                        
 For Developers                                                                                                                                                                         
                                                                                                                                                                                        
 "One API for all prediction markets. Sub-10ms latency. Production-ready from day one."                                                                                                 
                                                                                                                                                                                        
 Starter ($49): Prototype and test with real market data                                                                                                                                
 Pro ($149): Production deployment with arbitrage triggers                                                                                                                              
 Team ($399): Scale with HFT signals and guaranteed latency                                                                                                                             
 Business ($799): Full historical data and custom triggers                                                                                                                              
                                                                                                                                                                                        
 For Traders                                                                                                                                                                            
                                                                                                                                                                                        
 "Real-time arbitrage detection. Institutional-grade signals. Pay for edge, not hope."                                                                                                  
                                                                                                                                                                                        
 Starter ($49): Basic price alerts and dashboard                                                                                                                                        
 Pro ($149): YES/NO arbitrage alerts, faster execution                                                                                                                                  
 Team ($399): Multi-outcome arb, whale tracking, sub-50ms latency                                                                                                                       
 Business ($799): Custom triggers, maximum speed, full history                                                                                                                          
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 Immediate $5K MRR Playbook (Week 1)                                                                                                                                                    
                                                                                                                                                                                        
 Why No Free Tier Works                                                                                                                                                                 
                                                                                                                                                                                        
 Core Insight: Polymarket traders are already profitable. A free tier attracts tire-kickers. Serious traders will pay $49 for immediate value.                                          
                                                                                                                                                                                        
 7-Day Trial Strategy:                                                                                                                                                                  
 - All tiers include 7-day trial (credit card required upfront)                                                                                                                         
 - Trial shows full Pro features (taste of arb detection)                                                                                                                               
 - Aggressive "trial ending" emails with arb $ opportunity missed                                                                                                                       
 - 60%+ trial-to-paid conversion (credit card required)                                                                                                                                 
                                                                                                                                                                                        
 Week 1 Launch Targets                                                                                                                                                                  
 ┌──────────┬──────┬──────┬──────────┬─────────────┬──────────────┬────────┐                                                                                                            
 │   Tier   │ Base │ Subs │ Base MRR │ API Overage │ Data Overage │ Total  │                                                                                                            
 ├──────────┼──────┼──────┼──────────┼─────────────┼──────────────┼────────┤                                                                                                            
 │ Starter  │ $19  │ 28   │ $532     │ $336        │ $0           │ $868   │                                                                                                            
 ├──────────┼──────┼──────┼──────────┼─────────────┼──────────────┼────────┤                                                                                                            
 │ Pro      │ $49  │ 18   │ $882     │ $540        │ $360         │ $1,782 │                                                                                                            
 ├──────────┼──────┼──────┼──────────┼─────────────┼──────────────┼────────┤                                                                                                            
 │ Team     │ $149 │ 7    │ $1,043   │ $420        │ $315         │ $1,778 │                                                                                                            
 ├──────────┼──────┼──────┼──────────┼─────────────┼──────────────┼────────┤                                                                                                            
 │ Business │ $399 │ 2    │ $798     │ $240        │ $160         │ $1,198 │                                                                                                            
 ├──────────┼──────┼──────┼──────────┼─────────────┼──────────────┼────────┤                                                                                                            
 │ Total    │ -    │ 55   │ $3,255   │ $1,536      │ $835         │ $5,626 │                                                                                                            
 └──────────┴──────┴──────┴──────────┴─────────────┴──────────────┴────────┘                                                                                                            
 Lower base = higher conversion. Data access drives additional overage revenue.                                                                                                         
                                                                                                                                                                                        
 Acquisition Channels (Zero Sales)                                                                                                                                                      
                                                                                                                                                                                        
 Channel 1: Polymarket Discord (30 trials)                                                                                                                                              
 - Post: "Built sub-10ms arb detection. 7-day free trial."                                                                                                                              
 - Reply to every trader asking about automation                                                                                                                                        
 - DM top leaderboard traders with personalized pitch                                                                                                                                   
                                                                                                                                                                                        
 Channel 2: Twitter/X Thread (20 trials)                                                                                                                                                
 Thread: "I analyzed 50,000 Polymarket orderbooks. Here's what I found.                                                                                                                 
                                                                                                                                                                                        
 1/ The average YES/NO arbitrage opportunity lasts 47 seconds                                                                                                                           
 2/ 73% of arb opportunities are <$50 profit (not worth manual execution)                                                                                                               
 3/ The remaining 27% represent $X,XXX/day in potential profit                                                                                                                          
 4/ Here's how to catch them automatically... [link to 7-day trial]"                                                                                                                    
                                                                                                                                                                                        
 Channel 3: Telegram Groups (10 trials)                                                                                                                                                 
 - Join prediction market trading groups                                                                                                                                                
 - Share valuable insights first (build credibility)                                                                                                                                    
 - Mention tool when asked about automation                                                                                                                                             
                                                                                                                                                                                        
 Channel 4: Reddit (5 trials)                                                                                                                                                           
 - r/polymarket, r/algotrading                                                                                                                                                          
 - Post case study with real numbers                                                                                                                                                    
 - Respond helpfully to automation questions                                                                                                                                            
                                                                                                                                                                                        
 Trial Conversion Mechanics                                                                                                                                                             
                                                                                                                                                                                        
 During Trial (Automated):                                                                                                                                                              
 Day 1: Welcome email + quick start guide                                                                                                                                               
 Day 2: "You've detected 3 arb opportunities worth $127"                                                                                                                                
 Day 4: "Pro tip: Enable webhook for instant alerts"                                                                                                                                    
 Day 5: "Trial ending in 48 hours. You've found $312 in opportunities."                                                                                                                 
 Day 6: "Last chance: Keep your arb alerts or lose access tomorrow"                                                                                                                     
 Day 7: Auto-convert to paid (card on file)                                                                                                                                             
                                                                                                                                                                                        
 Upgrade Prompts (In-App):                                                                                                                                                              
 - Hit rate limit → "Upgrade to Pro for 3x more requests"                                                                                                                               
 - Try arb trigger → "Arbitrage detection requires Pro tier"                                                                                                                            
 - View 8+ day history → "Unlock 30 days with Pro"                                                                                                                                      
 - Try HFT signal → "Team tier required for microprice divergence"                                                                                                                      
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 PLG Growth Engine                                                                                                                                                                      
                                                                                                                                                                                        
 Viral Loops                                                                                                                                                                            
                                                                                                                                                                                        
 1. Referral Program (20% Revenue Share + Tier Unlocks)                                                                                                                                 
                                                                                                                                                                                        
 Revenue Share:                                                                                                                                                                         
 - Every user gets unique referral code                                                                                                                                                 
 - 20% of referred user's revenue for 12 months                                                                                                                                         
 - Self-serve payout via Stripe Connect                                                                                                                                                 
                                                                                                                                                                                        
 Tier Unlock Rewards:                                                                                                                                                                   
 ┌──────────────────────────┬─────────────────────────────────────────────┐                                                                                                             
 │ Monthly Referral Revenue │                   Reward                    │                                                                                                             
 ├──────────────────────────┼─────────────────────────────────────────────┤                                                                                                             
 │ $100/mo generated        │ Unlock Pro features (while maintained)      │                                                                                                             
 ├──────────────────────────┼─────────────────────────────────────────────┤                                                                                                             
 │ $300/mo generated        │ Unlock Team features (while maintained)     │                                                                                                             
 ├──────────────────────────┼─────────────────────────────────────────────┤                                                                                                             
 │ $750/mo generated        │ Unlock Business features (while maintained) │                                                                                                             
 └──────────────────────────┴─────────────────────────────────────────────┘                                                                                                             
 Example: Refer 6 Pro users ($49 × 6 = $294 MRR generated) → You get Team features ($149 value) for free as long as referrals stay active.                                              
                                                                                                                                                                                        
 Why This Works:                                                                                                                                                                        
 - Power users become evangelists                                                                                                                                                       
 - Lower CAC through word-of-mouth                                                                                                                                                      
 - Referrers have skin in the game (features tied to referral retention)                                                                                                                
 - Creates "earn your way up" path for budget-conscious users                                                                                                                           
                                                                                                                                                                                        
 2. Public Leaderboard                                                                                                                                                                  
 - "Top Arb Hunters This Week" (opt-in)                                                                                                                                                 
 - "Top Graph Contributors" (most market links)                                                                                                                                         
 - Shows profitable opportunities detected                                                                                                                                              
 - Social proof drives signups                                                                                                                                                          
                                                                                                                                                                                        
 3. Embeddable Widgets                                                                                                                                                                  
 - OHLC charts for blogs/newsletters                                                                                                                                                    
 - Market relationship graphs (visual)                                                                                                                                                  
 - "Powered by Indication" branding                                                                                                                                                     
 - Click-through to trial signup                                                                                                                                                        
                                                                                                                                                                                        
 4. Twitter/Discord Bot (Viral Distribution)                                                                                                                                            
 - Posts significant arb opportunities (delayed 60s for paid users)                                                                                                                     
 - "Detected by @IndicationHQ - get real-time alerts [link]"                                                                                                                            
 - Followers become trials                                                                                                                                                              
                                                                                                                                                                                        
 Upgrade Triggers (Automated)                                                                                                                                                           
 ┌───────────────────────┬───────────────────────────────────────────┬────────────────────┐                                                                                             
 │        Trigger        │                  Message                  │    Target Tier     │                                                                                             
 ├───────────────────────┼───────────────────────────────────────────┼────────────────────┤                                                                                             
 │ Rate limit at 80%     │ "Running low on requests"                 │ Next tier          │                                                                                             
 ├───────────────────────┼───────────────────────────────────────────┼────────────────────┤                                                                                             
 │ Rate limit hit        │ "Upgrade now for instant access"          │ Next tier          │                                                                                             
 ├───────────────────────┼───────────────────────────────────────────┼────────────────────┤                                                                                             
 │ Blocked feature       │ "This requires [Tier] - upgrade?"         │ Required tier      │                                                                                             
 ├───────────────────────┼───────────────────────────────────────────┼────────────────────┤                                                                                             
 │ Approaching trial end │ "Don't lose your arb alerts"              │ Current trial tier │                                                                                             
 ├───────────────────────┼───────────────────────────────────────────┼────────────────────┤                                                                                             
 │ Using feature heavily │ "You're a power user - upgrade for more"  │ Next tier          │                                                                                             
 ├───────────────────────┼───────────────────────────────────────────┼────────────────────┤                                                                                             
 │ 30-day retention      │ "Unlock Team features - you've earned it" │ Team               │                                                                                             
 └───────────────────────┴───────────────────────────────────────────┴────────────────────┘                                                                                             
 ---                                                                                                                                                                                    
 Financial Projections                                                                                                                                                                  
                                                                                                                                                                                        
 Revenue Model: Base + API Overage + Data Overage                                                                                                                                       
 ┌─────────────────┬──────┬─────────┬─────────────┬──────────────┬────────────┐                                                                                                         
 │      Tier       │ Base │ % Users │ API Overage │ Data Overage │ Total ARPU │                                                                                                         
 ├─────────────────┼──────┼─────────┼─────────────┼──────────────┼────────────┤                                                                                                         
 │ Starter ($19)   │ $19  │ 50%     │ $12         │ $0           │ $31        │                                                                                                         
 ├─────────────────┼──────┼─────────┼─────────────┼──────────────┼────────────┤                                                                                                         
 │ Pro ($49)       │ $49  │ 32%     │ $30         │ $20          │ $99        │                                                                                                         
 ├─────────────────┼──────┼─────────┼─────────────┼──────────────┼────────────┤                                                                                                         
 │ Team ($149)     │ $149 │ 14%     │ $60         │ $45          │ $254       │                                                                                                         
 ├─────────────────┼──────┼─────────┼─────────────┼──────────────┼────────────┤                                                                                                         
 │ Business ($399) │ $399 │ 4%      │ $120        │ $80          │ $599       │                                                                                                         
 └─────────────────┴──────┴─────────┴─────────────┴──────────────┴────────────┘                                                                                                         
 Blended ARPU: $105/mo (base $56 + API overage $32 + data overage $17)                                                                                                                  
                                                                                                                                                                                        
 Year 1 Monthly Progression                                                                                                                                                             
 ┌───────┬────────────┬─────────────┬────────────┬──────────┬─────────────┬───────────┐                                                                                                 
 │ Month │ New Trials │ Conversions │ Total Paid │ Base MRR │ Overage MRR │ Total MRR │                                                                                                 
 ├───────┼────────────┼─────────────┼────────────┼──────────┼─────────────┼───────────┤                                                                                                 
 │ 1     │ 85         │ 55          │ 55         │ $3.1K    │ $2.1K       │ $5.2K     │                                                                                                 
 ├───────┼────────────┼─────────────┼────────────┼──────────┼─────────────┼───────────┤                                                                                                 
 │ 2     │ 160        │ 104         │ 150        │ $8.4K    │ $6.4K       │ $14.8K    │                                                                                                 
 ├───────┼────────────┼─────────────┼────────────┼──────────┼─────────────┼───────────┤                                                                                                 
 │ 3     │ 220        │ 143         │ 270        │ $15.1K   │ $12.6K      │ $27.7K    │                                                                                                 
 ├───────┼────────────┼─────────────┼────────────┼──────────┼─────────────┼───────────┤                                                                                                 
 │ 4     │ 260        │ 169         │ 400        │ $22.4K   │ $19.6K      │ $42.0K    │                                                                                                 
 ├───────┼────────────┼─────────────┼────────────┼──────────┼─────────────┼───────────┤                                                                                                 
 │ 5     │ 280        │ 182         │ 530        │ $29.7K   │ $26.2K      │ $55.9K    │                                                                                                 
 ├───────┼────────────┼─────────────┼────────────┼──────────┼─────────────┼───────────┤                                                                                                 
 │ 6     │ 280        │ 182         │ 650        │ $36.4K   │ $32.3K      │ $68.7K    │                                                                                                 
 ├───────┼────────────┼─────────────┼────────────┼──────────┼─────────────┼───────────┤                                                                                                 
 │ 7     │ 260        │ 169         │ 750        │ $42.0K   │ $37.8K      │ $79.8K    │                                                                                                 
 ├───────┼────────────┼─────────────┼────────────┼──────────┼─────────────┼───────────┤                                                                                                 
 │ 8     │ 240        │ 156         │ 840        │ $47.0K   │ $42.5K      │ $89.5K    │                                                                                                 
 ├───────┼────────────┼─────────────┼────────────┼──────────┼─────────────┼───────────┤                                                                                                 
 │ 9     │ 220        │ 143         │ 910        │ $51.0K   │ $46.4K      │ $97.4K    │                                                                                                 
 ├───────┼────────────┼─────────────┼────────────┼──────────┼─────────────┼───────────┤                                                                                                 
 │ 10    │ 200        │ 130         │ 970        │ $54.3K   │ $49.8K      │ $104.1K   │                                                                                                 
 ├───────┼────────────┼─────────────┼────────────┼──────────┼─────────────┼───────────┤                                                                                                 
 │ 11    │ 200        │ 130         │ 1,030      │ $57.7K   │ $53.2K      │ $110.9K   │                                                                                                 
 ├───────┼────────────┼─────────────┼────────────┼──────────┼─────────────┼───────────┤                                                                                                 
 │ 12    │ 200        │ 130         │ 1,090      │ $61.0K   │ $56.7K      │ $117.7K   │                                                                                                 
 └───────┴────────────┴─────────────┴────────────┴──────────┴─────────────┴───────────┘                                                                                                 
 Year 1 ARR: $1.41M (exceeds $1.1M target)                                                                                                                                              
                                                                                                                                                                                        
 Revenue Composition at Month 12                                                                                                                                                        
 ┌────────────────────┬─────────┬────────────┐                                                                                                                                          
 │       Source       │   MRR   │ % of Total │                                                                                                                                          
 ├────────────────────┼─────────┼────────────┤                                                                                                                                          
 │ Base Subscriptions │ $61.0K  │ 52%        │                                                                                                                                          
 ├────────────────────┼─────────┼────────────┤                                                                                                                                          
 │ API Overage        │ $34.9K  │ 30%        │                                                                                                                                          
 ├────────────────────┼─────────┼────────────┤                                                                                                                                          
 │ Data Overage       │ $21.8K  │ 18%        │                                                                                                                                          
 ├────────────────────┼─────────┼────────────┤                                                                                                                                          
 │ Total              │ $117.7K │ 100%       │                                                                                                                                          
 └────────────────────┴─────────┴────────────┘                                                                                                                                          
 Why This Model Works                                                                                                                                                                   
                                                                                                                                                                                        
 Lower Entry = Higher Conversion:                                                                                                                                                       
 - $19 Starter converts 65%+ (vs 50% at higher prices)                                                                                                                                  
 - Pro at $49 is impulse-friendly with clear value                                                                                                                                      
                                                                                                                                                                                        
 Data Overage Creates New Revenue Stream:                                                                                                                                               
 - Historical analysis is compute-intensive                                                                                                                                             
 - Users willingly pay for deeper data access                                                                                                                                           
 - Shared analyses create viral marketing                                                                                                                                               
                                                                                                                                                                                        
 Network Effects Compound Revenue:                                                                                                                                                      
 More users → More analyses shared → More awareness                                                                                                                                     
      ↓              ↓                    ↓                                                                                                                                             
 More graph data → Better recommendations → More upgrades                                                                                                                               
      ↓              ↓                    ↓                                                                                                                                             
 More data queries → More overage → More revenue                                                                                                                                        
                                                                                                                                                                                        
 Key Metrics                                                                                                                                                                            
                                                                                                                                                                                        
 - Trial-to-Paid Conversion: 65% (low base price)                                                                                                                                       
 - Monthly Churn: 4% (usage-based = sticky)                                                                                                                                             
 - Net Revenue Retention: 130% (overage + data + upgrades)                                                                                                                              
 - Blended ARPU: $105/mo                                                                                                                                                                
 - CAC: ~$18 (organic/referral + viral analyses)                                                                                                                                        
 - LTV: $2,730 (26-month lifetime at 130% NRR)                                                                                                                                          
 - LTV:CAC Ratio: 152:1                                                                                                                                                                 
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 Go-to-Market Phases                                                                                                                                                                    
                                                                                                                                                                                        
 Phase 1: Launch (Weeks 1-4)                                                                                                                                                            
                                                                                                                                                                                        
 Target: $5K → $20K MRR                                                                                                                                                                 
                                                                                                                                                                                        
 - Launch all 4 tiers with Stripe self-checkout                                                                                                                                         
 - 7-day trial with credit card required                                                                                                                                                
 - Polymarket Discord + Twitter launch campaign                                                                                                                                         
 - Telegram presence in trading groups                                                                                                                                                  
 - Referral program live from day 1                                                                                                                                                     
                                                                                                                                                                                        
 Phase 2: Optimize (Months 2-4)                                                                                                                                                         
                                                                                                                                                                                        
 Target: $20K → $55K MRR                                                                                                                                                                
                                                                                                                                                                                        
 - A/B test trial length, messaging, upgrade prompts                                                                                                                                    
 - Launch public leaderboard                                                                                                                                                            
 - Weekly "Arbitrage Report" content                                                                                                                                                    
 - YouTube tutorial content                                                                                                                                                             
 - Integration guides for popular tools                                                                                                                                                 
                                                                                                                                                                                        
 Phase 3: Expand (Months 5-8)                                                                                                                                                           
                                                                                                                                                                                        
 Target: $55K → $85K MRR                                                                                                                                                                
                                                                                                                                                                                        
 - Kalshi integration (new market = new audience)                                                                                                                                       
 - Affiliate partnerships with newsletters                                                                                                                                              
 - Podcast appearances                                                                                                                                                                  
 - Case studies from profitable users                                                                                                                                                   
                                                                                                                                                                                        
 Phase 4: Scale (Months 9-12)                                                                                                                                                           
                                                                                                                                                                                        
 Target: $85K → $105K MRR                                                                                                                                                               
                                                                                                                                                                                        
 - DEX integrations                                                                                                                                                                     
 - Advanced analytics features                                                                                                                                                          
 - API improvements based on feedback                                                                                                                                                   
 - Preparation for Series A if desired                                                                                                                                                  
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 Defensibility Analysis                                                                                                                                                                 
                                                                                                                                                                                        
 Technical Moats                                                                                                                                                                        
                                                                                                                                                                                        
 1. Sub-10ms latency - Durable Objects + edge architecture                                                                                                                              
 2. Multi-market abstraction - First unified prediction market API                                                                                                                      
 3. Arbitrage IP - YES/NO + multi-outcome detection                                                                                                                                     
 4. Data integrity - Hash chain validation unique to Indication                                                                                                                         
 5. Historical depth - 1-year retention creates switching costs                                                                                                                         
                                                                                                                                                                                        
 Network Effect Moats (NEW)                                                                                                                                                             
                                                                                                                                                                                        
 1. Market Relationship Graph - User-contributed links create unique dataset                                                                                                            
   - Competitors cannot replicate without similar user base                                                                                                                             
   - Graph quality improves with every multi-market trigger                                                                                                                             
   - Powers recommendations, search, and proactive arb detection                                                                                                                        
 2. Data Flywheel                                                                                                                                                                       
 More users → More multi-market triggers → Richer graph                                                                                                                                 
      ↓                                                                                                                                                                                 
 Better recommendations → Users add more markets → More usage                                                                                                                           
      ↓                                                                                                                                                                                 
 More overage revenue → Reinvest in features → More users                                                                                                                               
 3. Switching Costs                                                                                                                                                                     
   - Users' market links are proprietary to their account                                                                                                                               
   - Historical trigger performance tied to Indication data                                                                                                                             
   - Referral tier unlocks lost if they leave                                                                                                                                           
                                                                                                                                                                                        
 Business Moats                                                                                                                                                                         
                                                                                                                                                                                        
 1. Low base + overage - Easy entry, revenue scales with value                                                                                                                          
 2. Referral tier unlocks - Power users become invested evangelists                                                                                                                     
 3. Graph contribution rewards - Early users get lasting recognition                                                                                                                    
 4. First-mover - Building graph before competitors exist                                                                                                                               
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 Architecture: Market Relationship Graph                                                                                                                                                
                                                                                                                                                                                        
 Data Model                                                                                                                                                                             
                                                                                                                                                                                        
 New ClickHouse Tables:                                                                                                                                                                 
                                                                                                                                                                                        
 -- Market relationships (edges in graph)                                                                                                                                               
 CREATE TABLE market_relationships (                                                                                                                                                    
     market_a_id String,                                                                                                                                                                
     market_b_id String,                                                                                                                                                                
     relationship_type Enum('arbitrage', 'correlation', 'causal', 'user_linked'),                                                                                                       
     user_count UInt32,                                                                                                                                                                 
     correlation_coefficient Float64,                                                                                                                                                   
     first_linked_at DateTime64(3),                                                                                                                                                     
     last_activity_at DateTime64(3),                                                                                                                                                    
     total_triggers_fired UInt64                                                                                                                                                        
 ) ENGINE = ReplacingMergeTree()                                                                                                                                                        
 ORDER BY (market_a_id, market_b_id, relationship_type);                                                                                                                                
                                                                                                                                                                                        
 -- User-market links (for recommendations)                                                                                                                                             
 CREATE TABLE user_market_links (                                                                                                                                                       
     user_id String,                                                                                                                                                                    
     market_id String,                                                                                                                                                                  
     linked_at DateTime64(3),                                                                                                                                                           
     trigger_count UInt32,                                                                                                                                                              
     last_trigger_at DateTime64(3)                                                                                                                                                      
 ) ENGINE = ReplacingMergeTree()                                                                                                                                                        
 ORDER BY (user_id, market_id);                                                                                                                                                         
                                                                                                                                                                                        
 Graph Operations:                                                                                                                                                                      
 - addEdge(market_a, market_b, user_id) - When user creates multi-market trigger                                                                                                        
 - getRelated(market_id, limit) - Get related markets for recommendations                                                                                                               
 - getCluster(market_id) - Get market cluster for analysis                                                                                                                              
 - scoreEdge(market_a, market_b) - Calculate relationship strength                                                                                                                      
 - pruneWeakEdges() - Periodic cleanup of invalid relationships                                                                                                                         
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 Market Relationship Validation & Scoring                                                                                                                                               
                                                                                                                                                                                        
 Edge Scoring System (0-100)                                                                                                                                                            
                                                                                                                                                                                        
 Each edge gets a composite score based on:                                                                                                                                             
 ┌──────────────────────┬────────┬────────────────────────────────────────────────────┐                                                                                                 
 │        Factor        │ Weight │                    Calculation                     │                                                                                                 
 ├──────────────────────┼────────┼────────────────────────────────────────────────────┤                                                                                                 
 │ Price Correlation    │ 30%    │ Pearson correlation of mid-prices (30-day rolling) │                                                                                                 
 ├──────────────────────┼────────┼────────────────────────────────────────────────────┤                                                                                                 
 │ Volume Correlation   │ 15%    │ Correlation of trading volume patterns             │                                                                                                 
 ├──────────────────────┼────────┼────────────────────────────────────────────────────┤                                                                                                 
 │ Arb Success Rate     │ 25%    │ % of arb alerts that were actionable               │                                                                                                 
 ├──────────────────────┼────────┼────────────────────────────────────────────────────┤                                                                                                 
 │ User Adoption        │ 15%    │ log(user_count) normalized                         │                                                                                                 
 ├──────────────────────┼────────┼────────────────────────────────────────────────────┤                                                                                                 
 │ Temporal Consistency │ 15%    │ Stability of correlation across time windows       │                                                                                                 
 └──────────────────────┴────────┴────────────────────────────────────────────────────┘                                                                                                 
 Score Formula:                                                                                                                                                                         
 edge_score = (                                                                                                                                                                         
     0.30 * |price_correlation| * 100 +                                                                                                                                                 
     0.15 * |volume_correlation| * 100 +                                                                                                                                                
     0.25 * arb_success_rate * 100 +                                                                                                                                                    
     0.15 * min(log2(user_count + 1) * 20, 100) +                                                                                                                                       
     0.15 * temporal_consistency_score                                                                                                                                                  
 )                                                                                                                                                                                      
                                                                                                                                                                                        
 Validation Metrics                                                                                                                                                                     
                                                                                                                                                                                        
 Price Correlation:                                                                                                                                                                     
 - Rolling 30-day Pearson correlation of mid-prices                                                                                                                                     
 - Both positive AND negative correlations are meaningful (inverse relationships)                                                                                                       
 - Threshold: |r| < 0.2 = uncorrelated                                                                                                                                                  
                                                                                                                                                                                        
 Arb Success Rate:                                                                                                                                                                      
 - Track each arb trigger fire:                                                                                                                                                         
   - Was the spread > 0 when fired? (actionable)                                                                                                                                        
   - Was profit realized? (successful)                                                                                                                                                  
 - Score = actionable_alerts / total_alerts                                                                                                                                             
 - Requires 20+ alerts to be scored                                                                                                                                                     
                                                                                                                                                                                        
 Temporal Consistency:                                                                                                                                                                  
 - Compare correlation across windows: 7d vs 30d vs 90d                                                                                                                                 
 - High variance across windows = unstable = lower score                                                                                                                                
 - Formula: 100 - (std_dev_of_correlations * 200)                                                                                                                                       
                                                                                                                                                                                        
 Edge Quality Tiers                                                                                                                                                                     
 ┌─────────┬────────┬──────────────────────────────────────────┐                                                                                                                        
 │  Tier   │ Score  │                Treatment                 │                                                                                                                        
 ├─────────┼────────┼──────────────────────────────────────────┤                                                                                                                        
 │ Gold    │ 80-100 │ Featured in recommendations, highlighted │                                                                                                                        
 ├─────────┼────────┼──────────────────────────────────────────┤                                                                                                                        
 │ Silver  │ 50-79  │ Included in recommendations              │                                                                                                                        
 ├─────────┼────────┼──────────────────────────────────────────┤                                                                                                                        
 │ Bronze  │ 30-49  │ Available but not promoted               │                                                                                                                        
 ├─────────┼────────┼──────────────────────────────────────────┤                                                                                                                        
 │ Pending │ < 30   │ Under review, may be pruned              │                                                                                                                        
 └─────────┴────────┴──────────────────────────────────────────┘                                                                                                                        
 Automatic Pruning Rules                                                                                                                                                                
                                                                                                                                                                                        
 Soft Prune (Archive) when:                                                                                                                                                             
 - Score < 30 for 14 consecutive days                                                                                                                                                   
 - No user activity on edge for 60 days                                                                                                                                                 
 - Effect: Hidden from recommendations, kept in historical data                                                                                                                         
                                                                                                                                                                                        
 Hard Prune (Delete) when:                                                                                                                                                              
 - Score < 20 for 30 consecutive days                                                                                                                                                   
 - Arb success rate < 10% with 100+ alerts                                                                                                                                              
 - Single user AND correlation < 0.15 after 30 days                                                                                                                                     
 - Effect: Removed from graph entirely                                                                                                                                                  
                                                                                                                                                                                        
 Pruning Schedule:                                                                                                                                                                      
 - Daily: Recalculate scores for all active edges                                                                                                                                       
 - Weekly: Soft prune edges below threshold                                                                                                                                             
 - Monthly: Hard prune persistent low-quality edges                                                                                                                                     
                                                                                                                                                                                        
 User Feedback Integration                                                                                                                                                              
                                                                                                                                                                                        
 Implicit Signals:                                                                                                                                                                      
 ┌─────────────────────────────┬─────────────────┐                                                                                                                                      
 │           Action            │     Signal      │                                                                                                                                      
 ├─────────────────────────────┼─────────────────┤                                                                                                                                      
 │ User adds trigger to edge   │ +1 confidence   │                                                                                                                                      
 ├─────────────────────────────┼─────────────────┤                                                                                                                                      
 │ User removes trigger        │ -1 confidence   │                                                                                                                                      
 ├─────────────────────────────┼─────────────────┤                                                                                                                                      
 │ User ignores recommendation │ -0.5 confidence │                                                                                                                                      
 └─────────────────────────────┴─────────────────┘                                                                                                                                      
 Explicit Feedback (Pro+):                                                                                                                                                              
 - "Confirm relationship" button → +2 confidence                                                                                                                                        
 - "Report invalid" button → -3 confidence (triggers review)                                                                                                                            
                                                                                                                                                                                        
 New Database Tables                                                                                                                                                                    
                                                                                                                                                                                        
 -- Edge scores (updated daily via cron)                                                                                                                                                
 CREATE TABLE market_relationship_scores (                                                                                                                                              
     market_a_id String,                                                                                                                                                                
     market_b_id String,                                                                                                                                                                
     score_date Date,                                                                                                                                                                   
     price_correlation Float64,                                                                                                                                                         
     volume_correlation Float64,                                                                                                                                                        
     arb_success_rate Float64,                                                                                                                                                          
     user_count UInt32,                                                                                                                                                                 
     temporal_consistency Float64,                                                                                                                                                      
     composite_score Float64,                                                                                                                                                           
     quality_tier Enum('gold', 'silver', 'bronze', 'pending', 'archived')                                                                                                               
 ) ENGINE = ReplacingMergeTree()                                                                                                                                                        
 ORDER BY (market_a_id, market_b_id, score_date);                                                                                                                                       
                                                                                                                                                                                        
 -- Arb trigger performance tracking                                                                                                                                                    
 CREATE TABLE arb_trigger_performance (                                                                                                                                                 
     trigger_id String,                                                                                                                                                                 
     market_a_id String,                                                                                                                                                                
     market_b_id String,                                                                                                                                                                
     fired_at DateTime64(3),                                                                                                                                                            
     was_actionable Bool,                                                                                                                                                               
     spread_at_fire_bps Float64,                                                                                                                                                        
     was_profitable Bool,                                                                                                                                                               
     profit_bps Float64                                                                                                                                                                 
 ) ENGINE = MergeTree()                                                                                                                                                                 
 ORDER BY (market_a_id, market_b_id, fired_at)                                                                                                                                          
 TTL fired_at + INTERVAL 90 DAY;                                                                                                                                                        
                                                                                                                                                                                        
 API Endpoints                                                                                                                                                                          
                                                                                                                                                                                        
 GET  /api/v1/markets/:id/related           # Get related markets (scored)                                                                                                              
 GET  /api/v1/graph/edge/:a/:b/score        # Get edge score breakdown                                                                                                                  
 GET  /api/v1/graph/clusters                # Get market clusters                                                                                                                       
 GET  /api/v1/graph/quality/summary         # Graph health metrics                                                                                                                      
 POST /api/v1/graph/edge/:a/:b/feedback     # User feedback (Pro+)                                                                                                                      
 GET  /api/v1/graph/export                  # Export graph data (Business)                                                                                                              
                                                                                                                                                                                        
 Trigger Registration Changes                                                                                                                                                           
                                                                                                                                                                                        
 When creating a multi-market trigger:                                                                                                                                                  
 1. Validate all market IDs exist                                                                                                                                                       
 2. Create trigger as normal                                                                                                                                                            
 3. Call addEdge() for each market pair (creates with score=50 "pending")                                                                                                               
 4. Apply multi-market discount to overage rate                                                                                                                                         
 5. Edge enters scoring pipeline, quality determined over time                                                                                                                          
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 Implementation Priorities                                                                                                                                                              
                                                                                                                                                                                        
 Week 1: Launch Revenue (Critical)                                                                                                                                                      
                                                                                                                                                                                        
 1. Stripe products + checkout for 4 tiers                                                                                                                                              
 2. Usage metering + overage billing setup                                                                                                                                              
 3. 7-day trial flow with credit card required                                                                                                                                          
 4. Trial email sequence (7 emails)                                                                                                                                                     
 5. Landing page with pricing                                                                                                                                                           
                                                                                                                                                                                        
 Week 2-4: PLG Infrastructure                                                                                                                                                           
                                                                                                                                                                                        
 1. Referral system with tier unlock rewards                                                                                                                                            
 2. Usage dashboard showing limits + overage                                                                                                                                            
 3. Rate limiter with soft limits (overage vs hard block)                                                                                                                               
 4. Feature flags for tier gating                                                                                                                                                       
 5. Upgrade prompt optimization                                                                                                                                                         
                                                                                                                                                                                        
 Month 2: Network Effect Foundation                                                                                                                                                     
                                                                                                                                                                                        
 1. Market relationship table schema + scoring tables                                                                                                                                   
 2. Multi-market trigger discount logic                                                                                                                                                 
 3. GET /markets/:id/related endpoint (with scores)                                                                                                                                     
 4. "Users also track" recommendations in dashboard                                                                                                                                     
 5. TypeScript SDK (@indication/sdk)                                                                                                                                                    
                                                                                                                                                                                        
 Month 3: Graph Quality & Growth                                                                                                                                                        
                                                                                                                                                                                        
 1. Edge scoring cron job (daily calculation)                                                                                                                                           
 2. Automatic pruning pipeline (weekly soft, monthly hard)                                                                                                                              
 3. Public leaderboard (arb hunters + graph contributors)                                                                                                                               
 4. User feedback integration (confirm/report buttons)                                                                                                                                  
 5. Edge quality tier badges in UI                                                                                                                                                      
                                                                                                                                                                                        
 Month 4: Graph Visualization                                                                                                                                                           
                                                                                                                                                                                        
 1. Market cluster visualization                                                                                                                                                        
 2. Graph-powered search improvements                                                                                                                                                   
 3. Embeddable market graph widgets                                                                                                                                                     
 4. Edge score transparency (show users why markets are related)                                                                                                                        
                                                                                                                                                                                        
 Month 5+: Expansion                                                                                                                                                                    
                                                                                                                                                                                        
 1. Kalshi integration (new markets = new graph nodes)                                                                                                                                  
 2. Correlation-based auto-linking suggestions                                                                                                                                          
 3. Graph export API (Business tier)                                                                                                                                                    
 4. Advanced cluster analytics                                                                                                                                                          
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 Critical Files for Implementation                                                                                                                                                      
                                                                                                                                                                                        
 Existing Files to Modify                                                                                                                                                               
 ┌────────────────────────────────┬───────────────────────────────────────────────────┐                                                                                                 
 │              File              │                  Change Required                  │                                                                                                 
 ├────────────────────────────────┼───────────────────────────────────────────────────┤                                                                                                 
 │ src/middleware/rate-limiter.ts │ Soft limits + overage tracking (not hard blocks)  │                                                                                                 
 ├────────────────────────────────┼───────────────────────────────────────────────────┤                                                                                                 
 │ src/schemas/common.ts          │ UserTier with base limits + overage rates         │                                                                                                 
 ├────────────────────────────────┼───────────────────────────────────────────────────┤                                                                                                 
 │ src/core/triggers.ts           │ Multi-market trigger support + discount logic     │                                                                                                 
 ├────────────────────────────────┼───────────────────────────────────────────────────┤                                                                                                 
 │ src/routes/api-v1.ts           │ Usage metering per request + /markets/:id/related │                                                                                                 
 ├────────────────────────────────┼───────────────────────────────────────────────────┤                                                                                                 
 │ src/routes/backtest.ts         │ Tier-based limits with overage option             │                                                                                                 
 ├────────────────────────────────┼───────────────────────────────────────────────────┤                                                                                                 
 │ app/src/lib/config.ts          │ Dashboard usage display + overage alerts          │                                                                                                 
 └────────────────────────────────┴───────────────────────────────────────────────────┘                                                                                                 
 New Files to Create                                                                                                                                                                    
 ┌──────────────────────────────────┬─────────────────────────────────────────────────────┐                                                                                             
 │               File               │                       Purpose                       │                                                                                             
 ├──────────────────────────────────┼─────────────────────────────────────────────────────┤                                                                                             
 │ src/services/market-graph.ts     │ Graph operations (addEdge, getRelated, getCluster)  │                                                                                             
 ├──────────────────────────────────┼─────────────────────────────────────────────────────┤                                                                                             
 │ src/services/edge-scoring.ts     │ Calculate edge scores, correlation metrics          │                                                                                             
 ├──────────────────────────────────┼─────────────────────────────────────────────────────┤                                                                                             
 │ src/services/graph-pruning.ts    │ Soft/hard prune logic, quality tier assignment      │                                                                                             
 ├──────────────────────────────────┼─────────────────────────────────────────────────────┤                                                                                             
 │ src/services/usage-metering.ts   │ Track requests, calculate overage, Stripe reporting │                                                                                             
 ├──────────────────────────────────┼─────────────────────────────────────────────────────┤                                                                                             
 │ src/services/referral-rewards.ts │ Track referral revenue, tier unlock logic           │                                                                                             
 ├──────────────────────────────────┼─────────────────────────────────────────────────────┤                                                                                             
 │ schema/market_graph_tables.sql   │ ClickHouse schema for relationships + scores        │                                                                                             
 ├──────────────────────────────────┼─────────────────────────────────────────────────────┤                                                                                             
 │ src/routes/graph.ts              │ Graph API endpoints (related, score, feedback)      │                                                                                             
 ├──────────────────────────────────┼─────────────────────────────────────────────────────┤                                                                                             
 │ src/cron/edge-scoring.ts         │ Daily cron job for score recalculation              │                                                                                             
 ├──────────────────────────────────┼─────────────────────────────────────────────────────┤                                                                                             
 │ src/cron/graph-pruning.ts        │ Weekly/monthly pruning jobs                         │                                                                                             
 └──────────────────────────────────┴─────────────────────────────────────────────────────┘                                                                                             
 ---                                                                                                                                                                                    
 Verification Plan                                                                                                                                                                      
                                                                                                                                                                                        
 1. Usage Metering & Overage                                                                                                                                                            
   - Request counting accurate per user                                                                                                                                                 
   - Overage charges calculated correctly                                                                                                                                               
   - Stripe usage records sync properly                                                                                                                                                 
   - Spend caps respected when set                                                                                                                                                      
 2. Payment Flow                                                                                                                                                                        
   - Stripe checkout works for all 4 tiers                                                                                                                                              
   - Trial → paid conversion automated                                                                                                                                                  
   - Overage billing at end of period                                                                                                                                                   
   - Upgrade/downgrade prorates correctly                                                                                                                                               
 3. Market Relationship Graph                                                                                                                                                           
   - Multi-market triggers create edges correctly                                                                                                                                       
   - GET /markets/:id/related returns relevant results                                                                                                                                  
   - Discounts applied for multi-market triggers                                                                                                                                        
   - Graph persists across restarts                                                                                                                                                     
 4. Edge Scoring & Pruning                                                                                                                                                              
   - Correlation calculations match expected values                                                                                                                                     
   - Arb success rate tracking accurate                                                                                                                                                 
   - Scores update daily via cron                                                                                                                                                       
   - Soft prune hides low-score edges from recommendations                                                                                                                              
   - Hard prune removes edges from database                                                                                                                                             
   - Quality tiers (gold/silver/bronze) assigned correctly                                                                                                                              
   - User feedback affects confidence scores                                                                                                                                            
 5. Referral Tier Unlocks                                                                                                                                                               
   - Referral revenue tracked accurately                                                                                                                                                
   - Tier unlock triggers at correct thresholds                                                                                                                                         
   - Features unlock/lock with referral changes                                                                                                                                         
   - Payouts calculated correctly                                                                                                                                                       
 6. PLG Mechanics                                                                                                                                                                       
   - Upgrade prompts trigger at 80% of limit                                                                                                                                            
   - Overage warnings sent before billing                                                                                                                                               
   - Referral codes track correctly                                                                                                                                                     
   - Trial emails delivered on schedule                                                                                                                                                 
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 Execution Roadmap: MVP to $5K MRR                                                                                                                                                      
                                                                                                                                                                                        
 Current State Assessment                                                                                                                                                               
                                                                                                                                                                                        
 What Exists (from codebase):                                                                                                                                                           
 - Core backend: Cloudflare Workers + Durable Objects for orderbook management                                                                                                          
 - Trigger evaluation system (16+ trigger types)                                                                                                                                        
 - ClickHouse data persistence (BBO, trades, snapshots)                                                                                                                                 
 - React dashboard (basic trigger event display)                                                                                                                                        
 - SSE event streaming                                                                                                                                                                  
 - Rate limiting (3 tiers currently)                                                                                                                                                    
 - OpenAPI spec for market data endpoints                                                                                                                                               
                                                                                                                                                                                        
 What's Missing for Launch:                                                                                                                                                             
 - Payment infrastructure (Stripe)                                                                                                                                                      
 - User authentication + accounts                                                                                                                                                       
 - Usage metering + overage billing                                                                                                                                                     
 - User console (signup, billing, triggers)                                                                                                                                             
 - Alert delivery (Telegram, SMS, WebSocket)                                                                                                                                            
 - Landing page                                                                                                                                                                         
 - Status page                                                                                                                                                                          
 - Market relationship graph                                                                                                                                                            
 - Referral system                                                                                                                                                                      
 - Analysis sharing                                                                                                                                                                     
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 Phase 0: Landing Page & Console UI (Days 1-7)                                                                                                                                          
                                                                                                                                                                                        
 Goal: Build all user interfaces first, then wire up backend                                                                                                                            
                                                                                                                                                                                        
 0.1 Landing Page (Days 1-2)                                                                                                                                                            
                                                                                                                                                                                        
 Stack: React (extend existing app) + TailwindCSS                                                                                                                                       
                                                                                                                                                                                        
 Sections:                                                                                                                                                                              
 1. Hero - "Real-time prediction market data. Sub-10ms triggers."                                                                                                                       
   - Tagline for traders: "Never miss an arbitrage opportunity"                                                                                                                         
   - Tagline for developers: "One API for all prediction markets"                                                                                                                       
 2. Use Cases - Tabbed: Traders / Developers                                                                                                                                            
 3. Pricing Table - 4 tiers with feature comparison                                                                                                                                     
 4. How It Works - 3-step visual (Sign up → Create triggers → Get alerts)                                                                                                               
 5. Live Demo - Embedded dashboard showing real trigger events                                                                                                                          
 6. Social Proof - Testimonials placeholder, latency stats                                                                                                                              
 7. CTA - "Start 7-day trial" button (wired up in Phase 2)                                                                                                                              
                                                                                                                                                                                        
 Key Elements:                                                                                                                                                                          
 - Mobile-responsive                                                                                                                                                                    
 - Fast load (<2s)                                                                                                                                                                      
 - Clear pricing (base + overage explained)                                                                                                                                             
 - Trust signals: uptime, latency percentiles                                                                                                                                           
                                                                                                                                                                                        
 Files:                                                                                                                                                                                 
 - app/src/pages/landing.tsx (new)                                                                                                                                                      
 - app/src/components/landing/Hero.tsx                                                                                                                                                  
 - app/src/components/landing/PricingTable.tsx                                                                                                                                          
 - app/src/components/landing/UseCases.tsx                                                                                                                                              
 - app/src/components/landing/HowItWorks.tsx                                                                                                                                            
                                                                                                                                                                                        
 0.2 Console: Dashboard & Settings (Days 3-4)                                                                                                                                           
                                                                                                                                                                                        
 Pages to build (UI only, mock data initially):                                                                                                                                         
                                                                                                                                                                                        
 /dashboard - Main user dashboard                                                                                                                                                       
 - Usage gauge (requests used / included)                                                                                                                                               
 - Projected overage cost this period                                                                                                                                                   
 - Quick stats: triggers active, alerts sent today                                                                                                                                      
 - Recent trigger events (last 10)                                                                                                                                                      
 - Upgrade prompt when approaching limits                                                                                                                                               
                                                                                                                                                                                        
 /settings - Account settings                                                                                                                                                           
 - Profile info (email, name)                                                                                                                                                           
 - API key management (list, create, revoke)                                                                                                                                            
 - Notification preferences (Telegram, SMS, WebSocket, Webhook)                                                                                                                         
 - Webhook URL configuration                                                                                                                                                            
 - Spend cap setting                                                                                                                                                                    
                                                                                                                                                                                        
 /billing - Billing page                                                                                                                                                                
 - Current plan + features                                                                                                                                                              
 - Usage breakdown (API requests, data queries)                                                                                                                                         
 - Billing history                                                                                                                                                                      
 - Upgrade/downgrade buttons                                                                                                                                                            
 - Payment method (Stripe portal placeholder)                                                                                                                                           
                                                                                                                                                                                        
 Files:                                                                                                                                                                                 
 - app/src/pages/dashboard.tsx                                                                                                                                                          
 - app/src/pages/settings.tsx                                                                                                                                                           
 - app/src/pages/billing.tsx                                                                                                                                                            
 - app/src/components/billing/UsageGauge.tsx                                                                                                                                            
 - app/src/components/billing/PlanCard.tsx                                                                                                                                              
 - app/src/components/settings/ApiKeyManager.tsx                                                                                                                                        
 - app/src/components/settings/NotificationPrefs.tsx                                                                                                                                    
                                                                                                                                                                                        
 0.3 Console: Trigger Builder (Days 5-6)                                                                                                                                                
                                                                                                                                                                                        
 Pages:                                                                                                                                                                                 
                                                                                                                                                                                        
 /triggers - Trigger list                                                                                                                                                               
 - Table: name, type, asset(s), status, last fired, actions                                                                                                                             
 - Filter by type, status                                                                                                                                                               
 - Quick toggle enable/disable                                                                                                                                                          
                                                                                                                                                                                        
 /triggers/new - Trigger creation wizard                                                                                                                                                
 - Step 1: Select trigger type (cards with icons + descriptions)                                                                                                                        
   - Price triggers, Spread triggers, Arb triggers, HFT triggers                                                                                                                        
 - Step 2: Configure parameters                                                                                                                                                         
   - Asset selector (search markets)                                                                                                                                                    
   - Threshold inputs                                                                                                                                                                   
   - For multi-market: add related markets                                                                                                                                              
 - Step 3: Set delivery method                                                                                                                                                          
   - Telegram (connect button)                                                                                                                                                          
   - SMS (verify phone)                                                                                                                                                                 
   - WebSocket (show connection URL)                                                                                                                                                    
   - Webhook (URL + secret)                                                                                                                                                             
 - Step 4: Review + Create                                                                                                                                                              
                                                                                                                                                                                        
 /triggers/:id - Trigger detail                                                                                                                                                         
 - Configuration summary                                                                                                                                                                
 - Performance stats (fires, success rate)                                                                                                                                              
 - Recent events                                                                                                                                                                        
 - Edit / Delete buttons                                                                                                                                                                
                                                                                                                                                                                        
 Files:                                                                                                                                                                                 
 - app/src/pages/triggers/index.tsx                                                                                                                                                     
 - app/src/pages/triggers/new.tsx                                                                                                                                                       
 - app/src/pages/triggers/[id].tsx                                                                                                                                                      
 - app/src/components/triggers/TriggerTypeSelector.tsx                                                                                                                                  
 - app/src/components/triggers/TriggerConfigForm.tsx                                                                                                                                    
 - app/src/components/triggers/DeliveryMethodPicker.tsx                                                                                                                                 
 - app/src/components/triggers/MarketSelector.tsx                                                                                                                                       
                                                                                                                                                                                        
 0.4 Console: Analysis Builder (Day 7)                                                                                                                                                  
                                                                                                                                                                                        
 Pages:                                                                                                                                                                                 
                                                                                                                                                                                        
 /analyses - My analyses list                                                                                                                                                           
 - Table: name, markets, created, views, actions                                                                                                                                        
 - "New Analysis" button                                                                                                                                                                
                                                                                                                                                                                        
 /analyses/new - Analysis builder                                                                                                                                                       
 - Market selector (multi-select)                                                                                                                                                       
 - Date range picker                                                                                                                                                                    
 - Chart type (candlestick, line, comparison)                                                                                                                                           
 - Indicator overlays (optional)                                                                                                                                                        
 - Preview pane                                                                                                                                                                         
 - Save + Share buttons                                                                                                                                                                 
                                                                                                                                                                                        
 /a/:id - Public analysis view (shareable)                                                                                                                                              
 - Full chart                                                                                                                                                                           
 - "Made with Indication" branding                                                                                                                                                      
 - CTA: "Create your own analysis"                                                                                                                                                      
 - Embed code                                                                                                                                                                           
                                                                                                                                                                                        
 Files:                                                                                                                                                                                 
 - app/src/pages/analyses/index.tsx                                                                                                                                                     
 - app/src/pages/analyses/new.tsx                                                                                                                                                       
 - app/src/pages/a/[id].tsx (public route)                                                                                                                                              
 - app/src/components/analyses/ChartBuilder.tsx                                                                                                                                         
 - app/src/components/analyses/ShareCard.tsx                                                                                                                                            
                                                                                                                                                                                        
 0.5 Console: Referrals (Day 7)                                                                                                                                                         
                                                                                                                                                                                        
 /referrals - Referral dashboard                                                                                                                                                        
 - Unique referral code + copy button                                                                                                                                                   
 - Shareable link                                                                                                                                                                       
 - Stats: signups, active referrals, MRR generated                                                                                                                                      
 - Progress bar to next tier unlock                                                                                                                                                     
 - Tier unlock explainer                                                                                                                                                                
                                                                                                                                                                                        
 Files:                                                                                                                                                                                 
 - app/src/pages/referrals.tsx                                                                                                                                                          
 - app/src/components/referrals/ReferralStats.tsx                                                                                                                                       
 - app/src/components/referrals/TierProgress.tsx                                                                                                                                        
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 Phase 1: Backend Integrations (Days 8-14)                                                                                                                                              
                                                                                                                                                                                        
 Goal: Wire up auth, payments, and delivery systems to UI                                                                                                                               
                                                                                                                                                                                        
 1.1 Authentication (Days 8-9)                                                                                                                                                          
                                                                                                                                                                                        
 Stack: Clerk (fastest to market)                                                                                                                                                       
                                                                                                                                                                                        
 - Install Clerk SDK in Worker + React app                                                                                                                                              
 - Add sign-up/sign-in pages                                                                                                                                                            
 - Protect console routes with auth                                                                                                                                                     
 - Add auth middleware to API routes                                                                                                                                                    
 - Create API key generation endpoint                                                                                                                                                   
                                                                                                                                                                                        
 Wire up UI:                                                                                                                                                                            
 - Landing page CTA → Clerk sign-up                                                                                                                                                     
 - Settings page → real API key management                                                                                                                                              
 - Dashboard → user-specific data                                                                                                                                                       
                                                                                                                                                                                        
 Files:                                                                                                                                                                                 
 - src/middleware/auth.ts (new)                                                                                                                                                         
 - src/routes/auth.ts (new)                                                                                                                                                             
                                                                                                                                                                                        
 1.2 Stripe Integration (Days 10-11)                                                                                                                                                    
                                                                                                                                                                                        
 Stack: Stripe Checkout + Billing + Customer Portal                                                                                                                                     
                                                                                                                                                                                        
 - Create 4 Stripe Products (Starter/Pro/Team/Business)                                                                                                                                 
 - Configure usage-based metering for overages                                                                                                                                          
 - Set up webhook handlers for subscription events                                                                                                                                      
 - Implement Customer Portal redirect                                                                                                                                                   
                                                                                                                                                                                        
 Wire up UI:                                                                                                                                                                            
 - Pricing table → Stripe Checkout                                                                                                                                                      
 - Billing page → Stripe Customer Portal                                                                                                                                                
 - Dashboard → real usage data                                                                                                                                                          
 - Upgrade prompts → checkout links                                                                                                                                                     
                                                                                                                                                                                        
 Files:                                                                                                                                                                                 
 - src/routes/billing.ts (new)                                                                                                                                                          
 - src/services/stripe.ts (new)                                                                                                                                                         
 - src/webhooks/stripe.ts (new)                                                                                                                                                         
                                                                                                                                                                                        
 1.3 Alert Delivery System (Days 12-13)                                                                                                                                                 
                                                                                                                                                                                        
 Telegram:                                                                                                                                                                              
 - Create bot via BotFather                                                                                                                                                             
 - Build /connect flow in settings                                                                                                                                                      
 - Wire up trigger events → Telegram messages                                                                                                                                           
                                                                                                                                                                                        
 WebSocket:                                                                                                                                                                             
 - Authenticated /ws/alerts endpoint                                                                                                                                                    
 - Connection management in Durable Object                                                                                                                                              
 - Wire up trigger events → WS push                                                                                                                                                     
                                                                                                                                                                                        
 SMS (Twilio):                                                                                                                                                                          
 - Twilio account + number                                                                                                                                                              
 - Phone verification in settings                                                                                                                                                       
 - Wire up trigger events → SMS                                                                                                                                                         
                                                                                                                                                                                        
 Wire up UI:                                                                                                                                                                            
 - Settings → Telegram connect button works                                                                                                                                             
 - Settings → phone verification works                                                                                                                                                  
 - Trigger builder → delivery method saves                                                                                                                                              
 - Triggers → actually fire alerts                                                                                                                                                      
                                                                                                                                                                                        
 Files:                                                                                                                                                                                 
 - src/services/delivery/telegram.ts                                                                                                                                                    
 - src/services/delivery/websocket.ts                                                                                                                                                   
 - src/services/delivery/sms.ts                                                                                                                                                         
 - src/durable-objects/user-websocket.ts                                                                                                                                                
                                                                                                                                                                                        
 1.4 Database & Rate Limiting (Day 14)                                                                                                                                                  
                                                                                                                                                                                        
 ClickHouse tables:                                                                                                                                                                     
 - users (user_id, email, tier, stripe_id, created_at)                                                                                                                                  
 - api_keys (key_hash, user_id, name, created_at)                                                                                                                                       
 - usage_records (user_id, date, api_requests, data_rows)                                                                                                                               
 - user_triggers (trigger_id, user_id, config, status)                                                                                                                                  
 - analyses (analysis_id, user_id, config, views, created_at)                                                                                                                           
 - referrals (referrer_id, referee_id, created_at, status)                                                                                                                              
                                                                                                                                                                                        
 Rate limiting:                                                                                                                                                                         
 - Load tier from user context                                                                                                                                                          
 - Track requests in usage_records                                                                                                                                                      
 - Soft limits (overage) instead of hard blocks                                                                                                                                         
 - Usage headers in responses                                                                                                                                                           
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 Phase 2: Launch Infrastructure (Days 15-18)                                                                                                                                            
                                                                                                                                                                                        
 Goal: Docs, status page, polish                                                                                                                                                        
                                                                                                                                                                                        
 2.1 API Documentation (Day 15)                                                                                                                                                         
                                                                                                                                                                                        
 - Deploy Scalar docs at /docs                                                                                                                                                          
 - Add authentication section with examples                                                                                                                                             
 - Add code examples (TypeScript, Python, cURL)                                                                                                                                         
 - Document all trigger types                                                                                                                                                           
 - Document webhook payloads                                                                                                                                                            
                                                                                                                                                                                        
 2.2 Status Page (Day 16)                                                                                                                                                               
                                                                                                                                                                                        
 - Set up Openstatus at status.indication.xyz                                                                                                                                           
 - Monitor: API latency, WS connections, delivery rates                                                                                                                                 
 - Add status badge to landing + dashboard                                                                                                                                              
 - Configure Slack/PagerDuty alerts                                                                                                                                                     
                                                                                                                                                                                        
 2.3 Polish & Testing (Days 17-18)                                                                                                                                                      
                                                                                                                                                                                        
 - End-to-end test: signup → payment → trigger → alert                                                                                                                                  
 - Mobile responsiveness check                                                                                                                                                          
 - Error handling UX                                                                                                                                                                    
 - Loading states                                                                                                                                                                       
 - Empty states                                                                                                                                                                         
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 Phase 3: Network Effects (Days 15-21)                                                                                                                                                  
                                                                                                                                                                                        
 Goal: Build graph + referral system for viral growth                                                                                                                                   
                                                                                                                                                                                        
 3.1 Market Relationship Graph (MVP)                                                                                                                                                    
                                                                                                                                                                                        
 Start simple, iterate:                                                                                                                                                                 
                                                                                                                                                                                        
 V1 (Week 3):                                                                                                                                                                           
 - market_relationships table (ClickHouse)                                                                                                                                              
 - addEdge() on multi-market trigger creation                                                                                                                                           
 - GET /markets/:id/related returns user-linked markets                                                                                                                                 
 - Show "Users also track" in trigger builder                                                                                                                                           
                                                                                                                                                                                        
 V2 (Week 4+):                                                                                                                                                                          
 - Daily scoring cron job                                                                                                                                                               
 - Pruning pipeline                                                                                                                                                                     
 - Quality tier badges                                                                                                                                                                  
                                                                                                                                                                                        
 3.2 Referral System                                                                                                                                                                    
                                                                                                                                                                                        
 Stack: Custom (simple) or Rewardful (faster)                                                                                                                                           
                                                                                                                                                                                        
 Core Flow:                                                                                                                                                                             
 1. User gets unique referral code in dashboard                                                                                                                                         
 2. Referee signs up via ?ref=CODE                                                                                                                                                      
 3. System tracks: referrer_id, referee_id, referee_mrr                                                                                                                                 
 4. Calculate total referral MRR per user                                                                                                                                               
 5. Auto-unlock tier when threshold reached                                                                                                                                             
                                                                                                                                                                                        
 Tier Unlock Logic:                                                                                                                                                                     
 const referralMRR = getReferralMRR(userId);                                                                                                                                            
 if (referralMRR >= 750) return 'business';                                                                                                                                             
 if (referralMRR >= 300) return 'team';                                                                                                                                                 
 if (referralMRR >= 100) return 'pro';                                                                                                                                                  
 return currentTier;                                                                                                                                                                    
                                                                                                                                                                                        
 Dashboard UI:                                                                                                                                                                          
 - Referral code + copy button                                                                                                                                                          
 - Referral stats (signups, MRR generated)                                                                                                                                              
 - Progress to next tier unlock                                                                                                                                                         
 - Payout history (if cash option added later)                                                                                                                                          
                                                                                                                                                                                        
 3.3 Analysis Console (MVP)                                                                                                                                                             
                                                                                                                                                                                        
 Goal: Users create shareable analyses that drive virality                                                                                                                              
                                                                                                                                                                                        
 V1 Features:                                                                                                                                                                           
 - /analyses/new - Create analysis from historical data                                                                                                                                 
 - Simple chart builder (select markets, date range, overlay)                                                                                                                           
 - Save analysis to account                                                                                                                                                             
 - Share link: indication.xyz/a/abc123                                                                                                                                                  
 - Embed code for blogs                                                                                                                                                                 
                                                                                                                                                                                        
 Sharing Incentives:                                                                                                                                                                    
 - Track view count per analysis                                                                                                                                                        
 - Show "Shared analyses" leaderboard                                                                                                                                                   
 - 100+ views → 5,000 free data rows                                                                                                                                                    
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 Phase 4: Launch Week (Days 22-28)                                                                                                                                                      
                                                                                                                                                                                        
 Goal: Public launch, $5K MRR target                                                                                                                                                    
                                                                                                                                                                                        
 4.1 Pre-Launch (Days 22-24)                                                                                                                                                            
                                                                                                                                                                                        
 - Private beta with 10-20 Polymarket Discord users                                                                                                                                     
 - Fix critical bugs from beta feedback                                                                                                                                                 
 - Prepare launch content (Twitter thread, Discord post)                                                                                                                                
 - Set up analytics (Posthog or Plausible)                                                                                                                                              
                                                                                                                                                                                        
 4.2 Launch Day (Day 25)                                                                                                                                                                
                                                                                                                                                                                        
 Channels:                                                                                                                                                                              
 1. Twitter/X Thread (primary)                                                                                                                                                          
   - "Built sub-10ms arb detection for Polymarket. Here's what I learned."                                                                                                              
   - Screenshots of dashboard                                                                                                                                                           
   - Link to landing page                                                                                                                                                               
 2. Polymarket Discord                                                                                                                                                                  
   - Post in trading channel                                                                                                                                                            
   - Offer to answer questions                                                                                                                                                          
 3. Reddit                                                                                                                                                                              
   - r/polymarket, r/algotrading                                                                                                                                                        
   - Case study format                                                                                                                                                                  
 4. Telegram Groups                                                                                                                                                                     
   - Prediction market trading groups                                                                                                                                                   
   - Crypto trading groups                                                                                                                                                              
                                                                                                                                                                                        
 4.3 Week 1 Targets                                                                                                                                                                     
 ┌─────┬────────┬─────────────┬────────────────┐                                                                                                                                        
 │ Day │ Trials │ Conversions │ Cumulative MRR │                                                                                                                                        
 ├─────┼────────┼─────────────┼────────────────┤                                                                                                                                        
 │ 1   │ 15     │ 10          │ $950           │                                                                                                                                        
 ├─────┼────────┼─────────────┼────────────────┤                                                                                                                                        
 │ 2   │ 12     │ 8           │ $1,700         │                                                                                                                                        
 ├─────┼────────┼─────────────┼────────────────┤                                                                                                                                        
 │ 3   │ 10     │ 7           │ $2,350         │                                                                                                                                        
 ├─────┼────────┼─────────────┼────────────────┤                                                                                                                                        
 │ 4   │ 10     │ 7           │ $3,000         │                                                                                                                                        
 ├─────┼────────┼─────────────┼────────────────┤                                                                                                                                        
 │ 5   │ 12     │ 8           │ $3,750         │                                                                                                                                        
 ├─────┼────────┼─────────────┼────────────────┤                                                                                                                                        
 │ 6   │ 10     │ 7           │ $4,400         │                                                                                                                                        
 ├─────┼────────┼─────────────┼────────────────┤                                                                                                                                        
 │ 7   │ 10     │ 7           │ $5,050         │                                                                                                                                        
 └─────┴────────┴─────────────┴────────────────┘                                                                                                                                        
 ---                                                                                                                                                                                    
 Tech Stack Summary                                                                                                                                                                     
 ┌───────────┬────────────────┬──────────────────────────────────────────┐                                                                                                              
 │ Component │     Choice     │                Rationale                 │                                                                                                              
 ├───────────┼────────────────┼──────────────────────────────────────────┤                                                                                                              
 │ Auth      │ Clerk          │ Fastest to integrate, handles OAuth, MFA │                                                                                                              
 ├───────────┼────────────────┼──────────────────────────────────────────┤                                                                                                              
 │ Payments  │ Stripe         │ Industry standard, usage billing, portal │                                                                                                              
 ├───────────┼────────────────┼──────────────────────────────────────────┤                                                                                                              
 │ SMS       │ Twilio         │ Reliable, simple API                     │                                                                                                              
 ├───────────┼────────────────┼──────────────────────────────────────────┤                                                                                                              
 │ Telegram  │ Native Bot API │ Free, popular with traders               │                                                                                                              
 ├───────────┼────────────────┼──────────────────────────────────────────┤                                                                                                              
 │ Status    │ Openstatus.dev │ Free, beautiful, easy setup              │                                                                                                              
 ├───────────┼────────────────┼──────────────────────────────────────────┤                                                                                                              
 │ Docs      │ Scalar         │ Already have OpenAPI, great UX           │                                                                                                              
 ├───────────┼────────────────┼──────────────────────────────────────────┤                                                                                                              
 │ Analytics │ Posthog        │ PLG-focused, free tier generous          │                                                                                                              
 ├───────────┼────────────────┼──────────────────────────────────────────┤                                                                                                              
 │ Landing   │ Same React app │ Consistency, faster to build             │                                                                                                              
 └───────────┴────────────────┴──────────────────────────────────────────┘                                                                                                              
 ---                                                                                                                                                                                    
 File Structure: New Files Needed                                                                                                                                                       
                                                                                                                                                                                        
 src/                                                                                                                                                                                   
 ├── middleware/                                                                                                                                                                        
 │   └── auth.ts                    # Clerk/Auth0 middleware                                                                                                                            
 ├── routes/                                                                                                                                                                            
 │   ├── auth.ts                    # Login, signup, API keys                                                                                                                           
 │   ├── billing.ts                 # Stripe checkout, portal                                                                                                                           
 │   ├── triggers-user.ts           # User trigger CRUD                                                                                                                                 
 │   ├── analyses.ts                # Analysis creation/sharing                                                                                                                         
 │   └── referrals.ts               # Referral tracking                                                                                                                                 
 ├── services/                                                                                                                                                                          
 │   ├── stripe.ts                  # Stripe SDK wrapper                                                                                                                                
 │   ├── usage-metering.ts          # Track requests, calculate overage                                                                                                                 
 │   ├── referral-rewards.ts        # Tier unlock logic                                                                                                                                 
 │   ├── market-graph.ts            # Graph operations                                                                                                                                  
 │   └── delivery/                                                                                                                                                                      
 │       ├── telegram.ts            # Telegram Bot API                                                                                                                                  
 │       ├── sms.ts                 # Twilio SMS                                                                                                                                        
 │       └── websocket.ts           # WS connection manager                                                                                                                             
 ├── webhooks/                                                                                                                                                                          
 │   └── stripe.ts                  # Subscription lifecycle events                                                                                                                     
 └── cron/                                                                                                                                                                              
     ├── usage-aggregation.ts       # Daily usage → overage calc                                                                                                                        
     └── edge-scoring.ts            # Daily graph scoring                                                                                                                               
                                                                                                                                                                                        
 app/src/                                                                                                                                                                               
 ├── pages/                                                                                                                                                                             
 │   ├── landing.tsx                # Landing page                                                                                                                                      
 │   ├── signup.tsx                 # Tier selection + checkout                                                                                                                         
 │   ├── dashboard.tsx              # Usage + billing overview                                                                                                                          
 │   ├── triggers/                                                                                                                                                                      
 │   │   ├── index.tsx              # Trigger list                                                                                                                                      
 │   │   ├── new.tsx                # Trigger builder                                                                                                                                   
 │   │   └── [id].tsx               # Trigger detail                                                                                                                                    
 │   ├── analyses/                                                                                                                                                                      
 │   │   ├── index.tsx              # My analyses                                                                                                                                       
 │   │   ├── new.tsx                # Analysis builder                                                                                                                                  
 │   │   └── [id].tsx               # Public analysis view                                                                                                                              
 │   ├── settings.tsx               # API keys, notifications                                                                                                                           
 │   └── referrals.tsx              # Referral dashboard                                                                                                                                
 └── components/                                                                                                                                                                        
     ├── billing/                                                                                                                                                                       
     │   ├── UsageGauge.tsx                                                                                                                                                             
     │   ├── PricingTable.tsx                                                                                                                                                           
     │   └── UpgradePrompt.tsx                                                                                                                                                          
     ├── triggers/                                                                                                                                                                      
     │   ├── TriggerBuilder.tsx                                                                                                                                                         
     │   └── DeliveryConfig.tsx                                                                                                                                                         
     └── analyses/                                                                                                                                                                      
         ├── ChartBuilder.tsx                                                                                                                                                           
         └── ShareCard.tsx                                                                                                                                                              
                                                                                                                                                                                        
 schema/                                                                                                                                                                                
 ├── users.sql                      # Users + API keys                                                                                                                                  
 ├── usage.sql                      # Usage records                                                                                                                                     
 ├── referrals.sql                  # Referral tracking                                                                                                                                 
 └── analyses.sql                   # Saved analyses                                                                                                                                    
                                                                                                                                                                                        
 ---                                                                                                                                                                                    
 Success Metrics: Week 1 → Month 12                                                                                                                                                     
 ┌─────────────────┬────────┬─────────┬─────────┬──────────┐                                                                                                                            
 │     Metric      │ Week 1 │ Month 1 │ Month 6 │ Month 12 │                                                                                                                            
 ├─────────────────┼────────┼─────────┼─────────┼──────────┤                                                                                                                            
 │ Trials          │ 80     │ 350     │ 1,500   │ 2,500    │                                                                                                                            
 ├─────────────────┼────────┼─────────┼─────────┼──────────┤                                                                                                                            
 │ Paid Users      │ 55     │ 230     │ 650     │ 1,090    │                                                                                                                            
 ├─────────────────┼────────┼─────────┼─────────┼──────────┤                                                                                                                            
 │ MRR             │ $5K    │ $24K    │ $68K    │ $118K    │                                                                                                                            
 ├─────────────────┼────────┼─────────┼─────────┼──────────┤                                                                                                                            
 │ ARR             │ -      │ -       │ -       │ $1.41M   │                                                                                                                            
 ├─────────────────┼────────┼─────────┼─────────┼──────────┤                                                                                                                            
 │ Conversion Rate │ 65%    │ 65%     │ 43%     │ 44%      │                                                                                                                            
 ├─────────────────┼────────┼─────────┼─────────┼──────────┤                                                                                                                            
 │ Monthly Churn   │ -      │ 5%      │ 4%      │ 4%       │                                                                                                                            
 ├─────────────────┼────────┼─────────┼─────────┼──────────┤                                                                                                                            
 │ NRR             │ -      │ -       │ 125%    │ 130%     │                                                                                                                            
 └─────────────────┴────────┴─────────┴─────────┴──────────┘                                                                                                                            
 ---                                                                                                                                                                                    
 Risk Mitigation                                                                                                                                                                        
 ┌─────────────────────────────┬────────────────────────────────────────────────┐                                                                                                       
 │            Risk             │                   Mitigation                   │                                                                                                       
 ├─────────────────────────────┼────────────────────────────────────────────────┤                                                                                                       
 │ Stripe setup delays         │ Use Stripe Test Mode until ready               │                                                                                                       
 ├─────────────────────────────┼────────────────────────────────────────────────┤                                                                                                       
 │ Auth complexity             │ Start with Clerk (plug-and-play)               │                                                                                                       
 ├─────────────────────────────┼────────────────────────────────────────────────┤                                                                                                       
 │ Telegram bot approval       │ Submit early, have webhook fallback            │                                                                                                       
 ├─────────────────────────────┼────────────────────────────────────────────────┤                                                                                                       
 │ Landing page not converting │ A/B test headlines, iterate fast               │                                                                                                       
 ├─────────────────────────────┼────────────────────────────────────────────────┤                                                                                                       
 │ Not hitting $5K MRR         │ Extend beta, gather testimonials, retry launch │                                                                                                       
 └─────────────────────────────┴────────────────────────────────────────────────┘                                                                                                       
 ---                                                                                                                                                                                    
 Day-by-Day Execution Plan                                                                                                                                                              
                                                                                                                                                                                        
 Week 1: UI-First (All Interfaces)                                                                                                                                                      
 ┌─────┬────────────────────────────────┬─────────────────────────────────┐                                                                                                             
 │ Day │             Focus              │          Deliverables           │                                                                                                             
 ├─────┼────────────────────────────────┼─────────────────────────────────┤                                                                                                             
 │ 1   │ Landing page (hero, pricing)   │ Landing page structure complete │                                                                                                             
 ├─────┼────────────────────────────────┼─────────────────────────────────┤                                                                                                             
 │ 2   │ Landing page (use cases, CTAs) │ Landing page fully designed     │                                                                                                             
 ├─────┼────────────────────────────────┼─────────────────────────────────┤                                                                                                             
 │ 3   │ Dashboard + Settings UI        │ Console layout, navigation      │                                                                                                             
 ├─────┼────────────────────────────────┼─────────────────────────────────┤                                                                                                             
 │ 4   │ Billing page UI                │ Usage gauge, plan cards         │                                                                                                             
 ├─────┼────────────────────────────────┼─────────────────────────────────┤                                                                                                             
 │ 5   │ Trigger list + builder UI      │ Wizard steps, form components   │                                                                                                             
 ├─────┼────────────────────────────────┼─────────────────────────────────┤                                                                                                             
 │ 6   │ Analysis builder UI            │ Chart builder, share cards      │                                                                                                             
 ├─────┼────────────────────────────────┼─────────────────────────────────┤                                                                                                             
 │ 7   │ Referral page UI               │ Stats, progress bars            │                                                                                                             
 └─────┴────────────────────────────────┴─────────────────────────────────┘                                                                                                             
 Week 2: Backend Wiring                                                                                                                                                                 
 ┌─────┬────────────────────────────┬───────────────────────────────┐                                                                                                                   
 │ Day │           Focus            │         Deliverables          │                                                                                                                   
 ├─────┼────────────────────────────┼───────────────────────────────┤                                                                                                                   
 │ 8   │ Clerk auth setup           │ Sign-up/in flows work         │                                                                                                                   
 ├─────┼────────────────────────────┼───────────────────────────────┤                                                                                                                   
 │ 9   │ Auth integration           │ Protected routes, API keys    │                                                                                                                   
 ├─────┼────────────────────────────┼───────────────────────────────┤                                                                                                                   
 │ 10  │ Stripe products + checkout │ Pricing → checkout works      │                                                                                                                   
 ├─────┼────────────────────────────┼───────────────────────────────┤                                                                                                                   
 │ 11  │ Stripe portal + webhooks   │ Billing page functional       │                                                                                                                   
 ├─────┼────────────────────────────┼───────────────────────────────┤                                                                                                                   
 │ 12  │ Telegram delivery          │ Bot created, alerts work      │                                                                                                                   
 ├─────┼────────────────────────────┼───────────────────────────────┤                                                                                                                   
 │ 13  │ WebSocket delivery         │ WS endpoint, connection works │                                                                                                                   
 ├─────┼────────────────────────────┼───────────────────────────────┤                                                                                                                   
 │ 14  │ Database + rate limiting   │ Usage tracking, soft limits   │                                                                                                                   
 └─────┴────────────────────────────┴───────────────────────────────┘                                                                                                                   
 Week 3: Launch Prep + Network Effects                                                                                                                                                  
 ┌─────┬───────────────────────┬────────────────────────────────┐                                                                                                                       
 │ Day │         Focus         │          Deliverables          │                                                                                                                       
 ├─────┼───────────────────────┼────────────────────────────────┤                                                                                                                       
 │ 15  │ API docs (Scalar)     │ Docs deployed at /docs         │                                                                                                                       
 ├─────┼───────────────────────┼────────────────────────────────┤                                                                                                                       
 │ 16  │ Status page           │ Openstatus live                │                                                                                                                       
 ├─────┼───────────────────────┼────────────────────────────────┤                                                                                                                       
 │ 17  │ SMS delivery (Twilio) │ Phone verification works       │                                                                                                                       
 ├─────┼───────────────────────┼────────────────────────────────┤                                                                                                                       
 │ 18  │ Market graph MVP      │ Edges on multi-market triggers │                                                                                                                       
 ├─────┼───────────────────────┼────────────────────────────────┤                                                                                                                       
 │ 19  │ Referral system       │ Tracking + tier unlocks        │                                                                                                                       
 ├─────┼───────────────────────┼────────────────────────────────┤                                                                                                                       
 │ 20  │ Private beta          │ 10-20 users testing            │                                                                                                                       
 ├─────┼───────────────────────┼────────────────────────────────┤                                                                                                                       
 │ 21  │ Beta feedback         │ Fix critical issues            │                                                                                                                       
 └─────┴───────────────────────┴────────────────────────────────┘                                                                                                                       
 Week 4: Launch                                                                                                                                                                         
 ┌─────┬───────────────────┬──────────────────────────────┐                                                                                                                             
 │ Day │       Focus       │         Deliverables         │                                                                                                                             
 ├─────┼───────────────────┼──────────────────────────────┤                                                                                                                             
 │ 22  │ E2E testing       │ All flows verified           │                                                                                                                             
 ├─────┼───────────────────┼──────────────────────────────┤                                                                                                                             
 │ 23  │ Polish + fixes    │ UX improvements              │                                                                                                                             
 ├─────┼───────────────────┼──────────────────────────────┤                                                                                                                             
 │ 24  │ Launch content    │ Twitter thread, Discord post │                                                                                                                             
 ├─────┼───────────────────┼──────────────────────────────┤                                                                                                                             
 │ 25  │ LAUNCH            │ Go live on all channels      │                                                                                                                             
 ├─────┼───────────────────┼──────────────────────────────┤                                                                                                                             
 │ 26  │ Monitor + respond │ Answer questions             │                                                                                                                             
 ├─────┼───────────────────┼──────────────────────────────┤                                                                                                                             
 │ 27  │ Iterate           │ Quick fixes                  │                                                                                                                             
 ├─────┼───────────────────┼──────────────────────────────┤                                                                                                                             
 │ 28  │ Week 1 retro      │ Review $5K MRR target        │                                                                                                                             
 └─────┴───────────────────┴──────────────────────────────┘                                                                                                                             
 ---                                                                                                                                                                                    
 Immediate Next Steps (Start Today)                                                                                                                                                     
                                                                                                                                                                                        
 UI First - Build interfaces before integrations:                                                                                                                                       
                                                                                                                                                                                        
 1. Create landing page components                                                                                                                                                      
   - app/src/pages/landing.tsx                                                                                                                                                          
   - Hero, PricingTable, UseCases, HowItWorks components                                                                                                                                
   - Use mock data, wire up CTAs later                                                                                                                                                  
 2. Create console page shells                                                                                                                                                          
   - Dashboard, Settings, Billing, Triggers, Analyses, Referrals                                                                                                                        
   - Navigation + layout structure                                                                                                                                                      
   - Mock data for all components                                                                                                                                                       
 3. Build trigger builder wizard                                                                                                                                                        
   - TriggerTypeSelector (cards with all 16+ types)                                                                                                                                     
   - TriggerConfigForm (dynamic based on type)                                                                                                                                          
   - DeliveryMethodPicker (Telegram/SMS/WS/Webhook)                                                                                                                                     
 4. Build analysis chart builder                                                                                                                                                        
   - MarketSelector (search + multi-select)                                                                                                                                             
   - Date range picker                                                                                                                                                                  
   - Chart preview using existing lightweight-charts                                                                                                                                    
                                                                                                                                                                                        
 Then Wire Up (Week 2):                                                                                                                                                                 
 5. Create Clerk account + integrate auth                                                                                                                                               
 6. Create Stripe account + 4 products                                                                                                                                                  
 7. Create Telegram bot via BotFather                                                                                                                                                   
 8. Create ClickHouse tables (users, api_keys, etc.)                                                                                                                                    
                                                                                                                                                                                        
 UI-first approach ensures all flows are designed before backend complexity is added. 