////////////////////////////////////////////////////////////// ✅2️⃣ 알람 사운드 코드_ 시작////////////////////////////////////////////////
// offscreen.js는 알람 사운드 재생 기능
// 이 파일은 offscreen 페이지에서 실행되며, 알람 사운드를 재생합니다.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 1. 사운드 재생 요청 처리
    if (request.target === 'offscreen' && request.type === 'play-sound') {
        switch (request.sound) {
            case 'completion': playCompletionMelody(); break;
            case 'middle': playUrgentSirenSound(); break;
            case 'error': playErrorSound(); break;
            default: playShortNotificationSound(); break;
        }
        // 사운드 재생은 비동기 응답이 필요 없으므로 return;
        return; 
    }

    // 2. XML 파싱 요청 처리
    else if (request.action === 'parseXml') {
        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(request.xmlText, "text/xml");
            if (xmlDoc.getElementsByTagName('parsererror').length) {
                sendResponse({ error: 'XML 파싱 오류가 발생했습니다.' });
            } else {
                const visitorNodes = xmlDoc.getElementsByTagName("visitorcnt");
                if (visitorNodes.length === 0) {
                    sendResponse({ error: '방문자 데이터가 없습니다.' });
                } else {
                    const data = Array.from(visitorNodes).map(node => ({
                        date: node.getAttribute("id"),
                        count: node.getAttribute("cnt")
                    }));
                    sendResponse({ data: data });
                }
            }
        } catch (e) {
            sendResponse({ error: e.message });
        }
        return true; // 비동기 응답 필요
    }


    // ✅ PDF 파싱 (PDF.js 활용 - CSP 완벽 우회)
    else if (request.action === 'parsePdfData') {
        (async () => {
            try {
                // 1. PDF.js 라이브러리 초기화
                const pdfjsLib = window['pdfjs-dist/build/pdf'] || window.pdfjsLib;
                if (!pdfjsLib) throw new Error("PDF.js 라이브러리가 로드되지 않았습니다.");
                
                pdfjsLib.GlobalWorkerOptions.workerSrc = 'default_js/pdf.worker.min.js';

                // 2. Base64 데이터를 바이너리(Uint8Array)로 변환
                const base64 = request.base64.split(',')[1];
                const binaryString = atob(base64);
                const len = binaryString.length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }

                // 3. PDF 로드 및 해독
                const loadingTask = pdfjsLib.getDocument({ data: bytes });
                const pdf = await loadingTask.promise;
                
                let extractedText = [];
                const maxPages = Math.min(pdf.numPages, 30); // 과부하 방지 최대 30장 제한

                for (let i = 1; i <= maxPages; i++) {
                    const page = await pdf.getPage(i);
                    const content = await page.getTextContent();
                    const pageText = content.items.map(item => item.str).join(' ');
                    if (pageText.trim()) extractedText.push(`--- [${i}페이지] ---\n${pageText}`);
                }
                
                if (extractedText.length === 0) {
                    throw new Error("추출 가능한 텍스트가 없습니다. (글자가 아닌 이미지 스캔본일 수 있습니다)");
                }
                
                sendResponse({ success: true, text: extractedText.join('\n\n') });

            } catch (e) {
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }

    // 2-1. RSS XML 파싱 요청 처리
    else if (request.action === 'parseRssXml') {
        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(request.xmlText, "text/xml");
            
            // RSS 2.0 (Naver, Tistory) 또는 Atom (Blogspot) 분기 처리
            let items = xmlDoc.querySelectorAll("item"); // RSS 2.0
            let isAtom = false;
            if (items.length === 0) {
                items = xmlDoc.querySelectorAll("entry"); // Atom
                isAtom = true;
            }

            const result =[];
            const count = Math.min(items.length, request.count || 1);

            for (let i = 0; i < count; i++) {
                const item = items[i];
                const title = item.querySelector("title")?.textContent || "";
                
                let link = "";
                if (isAtom) {
                    const linkNode = Array.from(item.querySelectorAll("link")).find(l => l.getAttribute("rel") === "alternate");
                    link = linkNode ? linkNode.getAttribute("href") : "";
                } else {
                    link = item.querySelector("link")?.textContent || "";
                }


                // 본문: content:encoded, description, content, media:description 중 있는 것 추출 (유튜브 호환)
                let contentNode = item.querySelector("encoded") || item.querySelector("content");
                
                if (!contentNode) {
                    const mediaDesc = item.getElementsByTagName("media:description");
                    if (mediaDesc.length > 0) contentNode = mediaDesc[0];
                }
                
                if (!contentNode) {
                    contentNode = item.querySelector("description");
                }

                const content = contentNode?.textContent || "";

                
                
                // 태그 제거
                const cleanContent = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 1500); // AI 토큰 한도를 위해 1500자 제한

                result.push({ title, link, content: cleanContent });
            }
            sendResponse({ success: true, data: result });
        } catch (e) {
            sendResponse({ success: false, error: e.message });
        }
        return true;
    }


    // 3. 클립보드 읽기 요청 처리(쇼핑커넥트)
    else if (request.target === 'offscreen' && request.action === 'readClipboardFromOffscreen') {
        navigator.clipboard.readText()
            .then(text => {
                sendResponse({ success: true, text: text });
            })
            .catch(err => {
                // console.error('오프스크린 클립보드 읽기 실패:', err);
                sendResponse({ success: false, error: err.message });
            });
        return true; // 비동기 응답 필요
    }
    
    // 4. 이미지 생성 요청 처리
    else if (request.action === 'generateImages') {
        generateImagesAndHtml(request.html, request.title, request.unsplashApiKey)
            .then(result => sendResponse({ success: true, data: result }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // 비동기 응답 필요
    }

    // 5. 네이버 블로그, 티스토리, 유튜브, 뉴스 등 다양한 사이트의 본문을 추출
    // ✅ 자동화 포스팅시 사용되는 핵심 크롤링 로직 (naver_text_Crawling.js와는 별개로 자동화 포스팅시 사용됨) ✅
    else if (request.action === 'parseHtmlForContent') {
        try {
            const doc = new DOMParser().parseFromString(request.html, "text/html");
            let title = "";
            let content = "";

            // ✅ naver_text_Crawling.js의 모든 파싱 로직을 여기에 통합합니다.
            // 이 로직은 request.parseType에 관계없이 모든 사이트를 자동으로 감지합니다.

            // 네이버 블로그 (스마트에디터 ONE)
            let iframe = doc.querySelector("iframe#mainFrame");
            if (iframe) {
                let iframeDoc = iframe.contentDocument;
                title = iframeDoc.querySelector('meta[property="og:title"]')?.content || "";
                let contentElements = iframeDoc.querySelectorAll(".se-text-paragraph");
                if (contentElements.length > 0) {
                    content = Array.from(contentElements).map(el => el.innerText.trim()).join("\n\n");
                }
            }
            // ✅  네이버 브랜드 커넥트 스마트스토어 상품 상세 페이지 크롤링 로직
            else if (doc.querySelector("h3._copyable, .DCVBehA8ZB")) {
                // '상세정보 펼쳐보기' 버튼 클릭 로직은 offscreen.js에서 실행할 수 없으므로 제거됩니다.
                // 이 기능은 background.js에서 HTML을 가져오기 전에 처리되어야 합니다.
                
                // ─────────────────────────────────────────────────────────
                // 기본 정보
                // ─────────────────────────────────────────────────────────
                title = doc.querySelector("h3._copyable, .DCVBehA8ZB")?.innerText.trim() || doc.title;
                const price = doc.querySelector(".Xu9MEKUuIo .e1DMQNBPJ_, strong.wEPQoEcMgw .odm2nQMro3")?.innerText.trim() || "";
                const delivery = doc.querySelector(".ZhLYPRnZe1, .S2Mz7lITmZ")?.innerText.trim() || "";
                let reviewScore = doc.querySelector(".nI8wdMPKHV strong.rIXQgoa8Xl")?.innerText.trim() || "";
                if (reviewScore && reviewScore.startsWith("평점")) reviewScore = reviewScore.replace("평점", "").trim();
                if (reviewScore) reviewScore = `${reviewScore}평점`;
                const reviewCount = doc.querySelector(".nI8wdMPKHV a.yfYuXvGCiB strong.rIXQgoa8Xl")?.innerText.trim() || "";
                let imageUrl = doc.querySelector("div.bd_1uFKu img, .mdFeBiFowv img")?.src || doc.querySelector("meta[property='og:image']")?.content || "";

                // ─────────────────────────────────────────────────────────
                // 썸네일(추가이미지) 수집 로직
                // ─────────────────────────────────────────────────────────
                const upscaleToM510 = (u) => {
                    try {
                        const url = new URL(u); // location.href 제거
                        if (/shop-phinf\.pstatic\.net/i.test(url.hostname)) {
                            url.searchParams.set("type", "m510");
                            return url.toString();
                        }
                        return u;
                    } catch {
                        return /shop-phinf\.pstatic\.net/i.test(u) ? u.replace(/(\?|&)type=[^&]*/g, "").split("?")[0] + "?type=m510" : u;
                    }
                };
                const keyOf = (u) => (u || "").split("?")[0];
                const rawThumbs = Array.from(doc.querySelectorAll(".K4l1t0ryUq .AIvsO_QzbN a img")).map(img => img.src).filter(Boolean).map(s => { try { return new URL(s).toString(); } catch { return s; } }); // location.href 제거
                const mainKey = imageUrl ? keyOf(upscaleToM510(imageUrl)) : null;
                const extras = [];
                const seen = new Set(mainKey ? [mainKey] : []);
                for (const src of rawThumbs) {
                    const big = upscaleToM510(src);
                    const k = keyOf(big);
                    if (!seen.has(k)) {
                        seen.add(k);
                        extras.push(big);
                    }
                    if (extras.length >= 6) break;
                }

                const productInfoBlock = ""; // 상품 정보를 빈 문자열로 처리하여 제외

                // ─────────────────────────────────────────────────────────
                // 리뷰 텍스트만 수집 (리뷰 이미지는 제외)
                // ─────────────────────────────────────────────────────────
                const reviewElements = Array.from(doc.querySelectorAll("li.V5XROudBPi, ._23R-1e-Q7s")).slice(0, 4);
                const reviews = reviewElements.map((el, idx) => {
                    const text = el.querySelector("div.vhlVUsCtw3 span, ._2L3vDiadT9")?.innerText.trim() || "리뷰 내용을 가져올 수 없습니다.";
                    return `📝 리뷰 ${idx + 1}:\n${text}`; // 이미지 URL(img) 수집 로직 제거
                });

                // 본문 이미지 선택자 확장 및 type=w860 필터
                const bodyImages = Array.from(doc.querySelectorAll(".se-main-container img, .bd_1uFKu img, .se-component img, .product-content img, #INTRODUCE img, .uOXg8u0yzs img"))
                    .map(img => img.dataset.src || img.src) // data-src를 우선적으로 사용
                    .filter(src => src && !src.startsWith("data:"))
                    .filter(src => src.includes('type=w860'));
                
                const bodyImageList = bodyImages.length > 0 ? "📷 본문 이미지:\n" + bodyImages.join("\n") : "";

                // ─────────────────────────────────────────────────────────
                // 최종 content 구성 (productInfoBlock 제외)
                // ─────────────────────────────────────────────────────────
                content = [
                    price ? `💰 가격: ${price}원` : "",
                    delivery ? `🚚 배송: ${delivery}` : "",
                    reviewScore ? `⭐️ 리뷰 점수: ${reviewScore}` : "",
                    reviewCount ? `🧾 리뷰 수: ${reviewCount}건` : "",
                    "※ 사용가능한 이미지 파일은 대표 이미지, 소제목 이미지, 본문 이미지 입니다.",
                    imageUrl ? `🖼 대표 이미지: ${upscaleToM510(imageUrl)}` : "",
                    ...extras.map((u, i) => `🖼 소제목 이미지${i + 1}: ${u}`),
                    // productInfoBlock, // 상품 정보 블록 제외
                    ...reviews,
                    bodyImageList
                ].filter(Boolean).join("\n\n");
                
                
                // 제목과 본문을 합쳐서 최종 contentText 생성
                contentText = `${title}\n\n${content}`;
            }


            // ✅ 쿠팡(Coupang) 상품 페이지 파싱 (2025 최신 구조)
            else if (doc.querySelector(".prod-atf-contents")) {
                console.log("✅ 쿠팡 페이지 감지됨 (Offscreen Parser)");

                // --- 1. 기본 정보 추출 ---
                title = doc.querySelector("h1.product-title")?.innerText.trim() || "";

                // 가격 추출 (우선순위 기반)
                let price = "가격 정보 없음";
                const priceSelectors = [
                    '.final-price .price-amount', 
                    '.sales-price .price-amount', 
                    '.price-container .twc-text-red-700', 
                    '.total-price strong'
                ];

                for (const selector of priceSelectors) {
                    const priceElement = doc.querySelector(selector);
                    if (priceElement && priceElement.innerText) {
                        const priceText = priceElement.innerText.replace(/원|,/g, '').trim();
                        if (!isNaN(priceText)) {
                            price = `${parseInt(priceText, 10).toLocaleString()}원`;
                            break; 
                        }
                    }
                }

                const rating = doc.querySelector(".rating-count-txt")?.innerText.trim() || "평점 없음";
                
                // 상품 특징 (Bullet points)
                const features = Array.from(doc.querySelectorAll(".product-description ul li"))
                    .map(li => `• ${li.innerText.trim()}`)
                    .join("\n");

                // --- 2. 이미지 URL 추출 (상세 묘사용) ---
                const upscaleImage = (url) => url ? url.replace(/\/\d+x\d+ex\//, '/492x492ex/') : "";
                const mainImageEl = doc.querySelector('.product-image img[alt="Product image"]');
                const mainImageText = mainImageEl ? `🖼 대표 이미지: ${upscaleImage(mainImageEl.src)}` : "";
                
                // 소제목용 썸네일
                const thumbImages = Array.from(doc.querySelectorAll('.product-image ul li img'))
                    .map(img => upscaleImage(img.src))
                    .slice(0, 6);
                const subImagesText = thumbImages.length > 0 ? thumbImages.map((url, i) => `🖼 소제목 이미지${i + 1}: ${url}`).join("\n") : "";

                // --- 3. 상품 정보 테이블 추출 ---
                let specTable = "";
                const specItems = doc.querySelectorAll("#itemBrief table tr");
                if (specItems.length > 0) {
                    const specsList = [];
                    specItems.forEach(tr => {
                        const cells = tr.querySelectorAll('td');
                        if (cells.length === 4) { // 4칸 짜리 테이블 구조 확인
                            const key1 = tr.querySelector('th') ? tr.querySelector('th').innerText : cells[0].innerText;
                            // 쿠팡 스펙 테이블 구조에 따라 th/td가 섞여 있을 수 있음, 단순 텍스트 추출
                            specsList.push(tr.innerText.replace(/\t/g, ': ').trim());
                        }
                    });
                    // 테이블 구조가 복잡하므로 텍스트 전체를 가져와 정리
                    const rawTableText = doc.querySelector("#itemBrief")?.innerText.trim() || "";
                    if(rawTableText) specTable = `--- 상품 정보 ---\n${rawTableText}`;
                }

                // --- 4. 상세 이미지 리스트 ---
                const detailImages = Array.from(doc.querySelectorAll('.product-detail-content-inside .vendor-item img'))
                    .map(img => img.src)
                    .filter(src => src && !src.startsWith('data:'))
                    .slice(0, 10);
                const detailImagesText = detailImages.length > 0 ? `--- 상세 설명 이미지 ---\n` + detailImages.map((url, i) => `🖼 상세이미지${i + 1}: ${url}`).join("\n") : "";

                // --- 5. 리뷰 추출 ---
                let reviewsText = "";
                const reviewElements = Array.from(doc.querySelectorAll("#sdpReview article")).slice(0, 5);
                if (reviewElements.length > 0) {
                    const reviews = reviewElements.map((el, i) => {
                        const author = el.querySelector('span.sdp-review__article__list__info__user__name')?.innerText.trim() || `구매자 ${i + 1}`;
                        const reviewContent = el.querySelector('.sdp-review__article__list__review__content')?.innerText.trim() || "리뷰 내용 없음";
                        return `📝 ${author}의 리뷰:\n${reviewContent}`;
                    }).join("\n\n");
                    reviewsText = `--- 고객 이용 후기 (최신순 5개) ---\n${reviews}`;
                }

                // --- 6. 데이터 조합 ---
                // *주의: offscreen.js는 단순히 텍스트를 추출하는 역할이므로 
                // API 호출(링크 생성)은 하지 않고 있는 그대로의 텍스트 정보만 조합합니다.
                content = [
                    price ? `💰 가격: ${price}` : "",
                    `⭐️ ${rating}`,
                    features ? `--- 주요 특징 ---\n${features}` : "",
                    specTable,
                    "※ 사용가능한 이미지 파일은 대표 이미지, 소제목 이미지, 상세 설명 이미지 입니다.",
                    mainImageText,
                    subImagesText,
                    reviewsText,
                    detailImagesText
                ].filter(Boolean).join("\n\n");

                // 제목과 본문을 합침
                contentText = `${title}\n\n${content}`;
            }


            // ✅ 한국 알리익스프레스(AliExpress) 상품 페이지 크롤링 로직 (Offscreen용 정적 파싱)
            else if (doc.querySelector(".pdp-body-top-left")) {
                
                // --- 1. 기본 정보 추출 ---
                title = doc.querySelector("h1[data-pl='product-title']")?.innerText.trim() || "";
                const price = doc.querySelector(".price-kr--current--NhhwBO1")?.innerText.trim() || "";
                const ratingElement = doc.querySelector(".reviewer--rating--xrWWFzx");
                const rating = ratingElement ? ratingElement.textContent.trim() : "평점 없음";
                const soldCount = doc.querySelector(".reviewer--sold--ytPeoEy")?.innerText.trim() || "판매량 정보 없음";
                

                // --- 판매 포인트 추출 ---
                let sellingPointsText = "";
                const sellingPointsElements = doc.querySelectorAll("ul.seo-sellpoints--sellerPoint--RcmFO_y li pre");
                if (sellingPointsElements.length > 0) {
                    const points = Array.from(sellingPointsElements)
                        .map(pre => `• ${pre.innerText.trim()}`) // 각 포인트 앞에 • 추가
                        .filter(Boolean);

                    if (points.length > 0) {
                        sellingPointsText = `--- 판매 포인트 ---\n${points.join("\n")}`;
                    }
                }

                // --- 2. 이미지 URL 추출 ---
                const imageUrls = new Set();
                
                const mainImageSrc = doc.querySelector(".magnifier--image--RM17RL2")?.src;
                if (mainImageSrc) imageUrls.add(mainImageSrc.replace(/_\d+x\d+q\d+\.jpg_\.avif$/, '_960x960q75.jpg_.avif'));
                
                doc.querySelectorAll(".slider--item--RpyeewA img").forEach(img => {
                    if (img.src) {
                        const highResUrl = img.src.replace(/_\d+x\d+q\d+\.jpg_\.avif$/, '_960x960q75.jpg_.avif');
                        imageUrls.add(highResUrl);
                    }
                });
                
                const imageList = Array.from(imageUrls);
                const mainImageText = imageList[0] ? `🖼 대표 이미지: ${imageList[0]}` : "";
                const subImagesText = imageList.slice(1, 7).map((url, i) => `🖼 소제목 이미지${i + 1}: ${url}`).join("\n");
                
                // --- 3. 리뷰 추출 (최대 5개) ---
                const reviewElements = Array.from(doc.querySelectorAll(".list--itemBox--IRynCHN")).slice(0, 5);
                const reviews = reviewElements.map((review, i) => {
                    const author = review.querySelector(".list--itemInfo--URmp38d")?.innerText.split('|')[0].trim() || `구매자 ${i + 1}`;
                    const reviewTextElement = review.querySelector(".list--itemReview--xQUhO78");
                    const reviewText = reviewTextElement ? reviewTextElement.innerText.trim() : "리뷰 내용 없음";
                    return `📝 ${author}의 리뷰:\n${reviewText}`;
                }).join("\n\n");
                
                // --- 4. 상품 정보 테이블 추출 ---
                let specTable = "";
                const specItems = doc.querySelectorAll("#nav-specification .specification--prop--Jh28bKu");
                if (specItems.length > 0) {
                    const specs = Array.from(specItems).map(item => {
                        const key = item.querySelector(".specification--title--SfH3sA8 span")?.innerText.trim();
                        const value = item.querySelector(".specification--desc--Dxx6W0W span")?.innerText.trim();
                        return (key && value) ? `${key}: ${value}` : null;
                    }).filter(Boolean).join("\n");
                    specTable = `--- 상품 정보 ---\n${specs}`;
                }

                // --- 5. 상세 설명 (정적 파싱 한계로 인해 스크롤 로딩 불가) ---
                // Offscreen에서는 스크롤을 할 수 없으므로, 현재 HTML 문자열에 포함된 내용만 가져옵니다.
                // 보통 알리는 스크롤해야 상세설명이 로드되므로 여기서는 제한적일 수 있습니다.
                let finalDescription = "상세 설명을 찾을 수 없습니다. (스크롤 로딩 필요)";
                
                // --- 6. 추적 링크 ---
                // Offscreen에서는 버튼 클릭 및 클립보드 조작이 불가능하므로 빈 값으로 처리합니다.
                let trackingLink = ""; 

                // --- 7. 최종 Content 조합 ---
                content = [
                    trackingLink ? `🔗 추적 링크: ${trackingLink}` : "",                
                    price ? `💰 가격: ${price}` : "",
                    `⭐️ 평점: ${rating}`,
                    `📈 판매: ${soldCount}`,
                    sellingPointsText, // 판매 포인트 정보
                    specTable,
                    "※ 사용가능한 이미지 파일은 대표 이미지, 소제목 이미지 입니다.",
                    mainImageText,
                    subImagesText,
                    reviews ? `\n--- 고객 이용 후기 ---\n${reviews}` : "",
                    `\n--- 상품 상세 설명 ---\n${finalDescription}`
                ].filter(Boolean).join("\n\n");

                contentText = `${title}\n\n${content}`;
            }


            // ✅ 한국 알리익스프레스(AliExpress) 상품 페이지 (모바일 버전) - Offscreen 정적 파싱
            else if (doc.querySelector(".pdp-main-image-square")) {
                
                // --- 1. 기본 정보 추출 ---
                title = doc.querySelector("h1[data-tticheck='true'] span")?.innerText.trim() || "";
                const price = doc.querySelector(".price--current--CabqzFW")?.innerText.trim() || "";
                const ratingElement = doc.querySelector(".rate-info--num--D3D8sCP");
                const rating = ratingElement ? ratingElement.textContent.trim() : "평점 없음";
                const soldCount = ratingElement?.nextSibling?.textContent.trim() || "판매량 정보 없음";
                
                // --- 2. 이미지 URL 추출 ---
                const imageUrls = new Set();
                
                // 슬라이드 이미지 (DOM에 렌더링된 부분만 추출)
                const mainImageSlides = doc.querySelectorAll(".pdp-main-image-box .slide img");
                if (mainImageSlides.length > 0) {
                    // Offscreen에서는 transform 스타일 계산이 어려우므로 첫 번째 이미지를 가져옵니다.
                    const mainImageSrc = mainImageSlides[0]?.src;
                    if (mainImageSrc) imageUrls.add(mainImageSrc.replace(/_\d+x\d+q\d+\.jpg_\.avif$/, '_960x960q75.jpg_.avif'));
                }
                
                // 옵션 이미지
                doc.querySelectorAll(".sku-ui--image--qRnXrL_ img").forEach(img => {
                    if (img.src) {
                        const highResUrl = img.src.replace(/_\d+x\d+q\d+\.jpg_\.avif$/, '_960x960q75.jpg_.avif');
                        imageUrls.add(highResUrl);
                    }
                });
                
                const imageList = Array.from(imageUrls);
                const mainImageText = imageList[0] ? `🖼 대표 이미지: ${imageList[0]}` : "";
                const subImagesText = imageList.slice(1, 7).map((url, i) => `🖼 소제목 이미지${i + 1}: ${url}`).join("\n");
                
                // --- 3. 리뷰 추출 ---
                const reviewElements = Array.from(doc.querySelectorAll(".common-evaluation-item--header--n2KVZwE")).slice(0, 5);
                const reviews = reviewElements.map((review, i) => {
                    const author = review.querySelector("span")?.innerText.split(',')[0].trim() || `구매자 ${i + 1}`;
                    const reviewTextElement = review.parentElement ? review.parentElement.querySelector(".common-evaluation-item--buyerFeedback--Ft_4S8E") : null;
                    const reviewText = reviewTextElement ? reviewTextElement.innerText.trim() : "리뷰 내용 없음";
                    return `📝 ${author}의 리뷰:\n${reviewText}`;
                }).join("\n\n");
                
                // --- 4. 상품 정보 테이블 추출 ---
                let specTable = "";
                const specItems = doc.querySelectorAll(".specifications--item--B59aZ8o");
                if (specItems.length > 0) {
                    const specs = Array.from(specItems).map(item => {
                        const children = item.querySelectorAll("span");
                        if (children.length === 2) {
                            const key = children[0]?.innerText.trim();
                            const value = children[1]?.innerText.trim();
                            return (key && value) ? `${key}: ${value}` : null;
                        }
                        return null;
                    }).filter(Boolean).join("\n");
                    specTable = `--- 상품 정보 ---\n${specs}`;
                }

                // --- 5. 상세 설명 (Offscreen에서는 스크롤 불가하므로 현재 HTML 내 텍스트만 추출) ---
                let descriptionText = "";
                const descriptionContainer = doc.querySelector('div[class*="description--container"]');
                if (descriptionContainer) {
                    let fullText = descriptionContainer.innerText.trim();
                    const startIndex = Math.max(fullText.lastIndexOf('설명'), fullText.lastIndexOf('신고하기'));
                    if (startIndex !== -1) {
                        descriptionText = fullText.substring(startIndex + 2).trim();
                    } else {
                        descriptionText = fullText;
                    }
                }

                // 상세 이미지
                const descImages = Array.from(doc.querySelectorAll(".description--itemImage--TkRnWOU"))
                                    .map(img => img.src)
                                    .filter(src => src && !src.startsWith("data:"))
                                    .slice(0, 10);

                let finalDescription = descriptionText || "상세 설명을 찾을 수 없습니다.";
                if (descImages.length > 0) {
                    const imageListText = descImages.map((url, i) => `🖼 상세이미지${i + 1}: ${url}`).join("\n");
                    if (descriptionText) {
                        finalDescription += `\n\n--- 상세 설명 이미지 ---\n${imageListText}`;
                    } else {
                        finalDescription = `--- 상세 설명 이미지 ---\n${imageListText}`;
                    }
                }
                
                // --- 6. 추적 링크 ---
                // Offscreen에서는 API 호출을 위한 URL 정보가 없으므로 빈 값으로 처리
                let trackingLink = ""; 

                // --- 7. 최종 Content 조합 ---
                content = [
                    price ? `💰 가격: ${price}` : "",
                    `⭐️ 평점: ${rating}`,
                    `📈 ${soldCount}`,
                    trackingLink ? `🔗 추적 링크: ${trackingLink}` : "",
                    specTable,
                    "※ 사용가능한 이미지 파일은 대표 이미지, 소제목 이미지 입니다.",
                    mainImageText,
                    subImagesText,
                    reviews ? `\n--- 고객 이용 후기 ---  \n${reviews}` : "",
                    `\n--- 상품 상세 설명 ---\n${finalDescription}`
                ].filter(Boolean).join("\n\n");

                contentText = `${title}\n\n${content}`;
            }





            // ✅ 올리브영 상품 상세 페이지 (모바일 버전 대응) - Offscreen 정적 파싱
            else if (doc.querySelector(".GoodsDetailInfo_title__Vl_IP")) {
                try {
                    // 1. 기본 정보 추출
                    title = doc.querySelector(".GoodsDetailInfo_title__Vl_IP")?.innerText.trim() || "";
                    
                    let price = "";
                    const priceEl = doc.querySelector(".GoodsDetailInfo_price__AoTh8") || doc.querySelector(".GoodsDetailInfo_price-before__5az8B");
                    if (priceEl) {
                        price = priceEl.innerText.replace(/\n/g, "").trim();
                    }

                    const ratingEl = doc.querySelector(".ReviewArea_rating-star__al_PT .rating");
                    const rating = ratingEl ? ratingEl.innerText.replace("평점", "").trim() : "평점 없음";
                    
                    const reviewCountEl = doc.querySelector(".ReviewArea_review-count__WeZ28 button span");
                    const reviewCount = reviewCountEl ? reviewCountEl.innerText.trim() : "0";

                    // 2. 이미지 추출 (스와이퍼 내 이미지)
                    const mainImages = Array.from(doc.querySelectorAll(".swiper-slide img"))
                        .map(img => img.src)
                        .filter(src => src && !src.startsWith("data:"))
                        .slice(0, 5); // 최대 5장

                    const mainImageText = mainImages.length > 0 ? `🖼 대표 이미지: ${mainImages[0]}` : "";
                    const subImagesText = mainImages.length > 1 ? mainImages.slice(1).map((url, i) => `🖼 소제목 이미지${i + 1}: ${url}`).join("\n") : "";

                    // 3. 상세 설명 추출
                    let description = "";
                    const descContainer = doc.querySelector(".GoodsDetailTabs_contents-area__u_zj4");
                    
                    if (descContainer) {
                        // 텍스트 추출
                        const textParts = descContainer.innerText.trim();
                        if (textParts) description += textParts + "\n\n";
                    }

                    // 4. 추적 링크 (Offscreen에서는 비동기 통신이 제한적이므로 빈 값 처리, 필요시 Background에서 주입)
                    let trackingLink = "";

                    // 5. 최종 조합
                    content = [
                        trackingLink ? `🔗 추적 링크: ${trackingLink}` : "", 
                        price ? `💰 가격: ${price}` : "",
                        `⭐️ 평점: ${rating} (리뷰 ${reviewCount}건)`,
                        "※ 사용가능한 이미지 파일은 대표 이미지, 소제목 이미지, 상세 설명 이미지 입니다.",
                        mainImageText,
                        subImagesText,
                        `\n--- 상품 상세 설명 ---\n${description}`
                    ].filter(Boolean).join("\n\n");

                    contentText = `${title}\n\n${content}`;

                } catch (e) {
                    contentText = "올리브영 파싱 오류: " + e.message;
                }
            }

            



            // ✅ 네이버 스포츠 기사 처리 
            else if (doc.querySelector("._article_content")) {
                title = doc.querySelector("meta[property='og:title']")?.content || doc.title;
                let contentElement = doc.querySelector("._article_content");
                content = contentElement ? contentElement.innerText.trim() : "네이버 스포츠 본문을 찾을 수 없습니다.";
                contentText = `${title}\n\n${content}`;
            }

            // ✅ 네이트 뉴스 본문 가져오기
            else if (doc.querySelector("#realArtcContents")) {
                title = doc.querySelector("meta[property='og:title']")?.content || doc.title;
                let contentElement = doc.querySelector("#realArtcContents");
                content = contentElement ? contentElement.innerText.trim() : "네이트 뉴스 본문을 찾을 수 없습니다.";
                contentText = `${title}\n\n${content}`;
            }

            // ✅ 네이트 스포츠 본문 가져오기
            else if (doc.querySelector(".content_view")) {
                title = doc.querySelector("meta[property='og:title']")?.content || doc.title;
                let contentElement = doc.querySelector(".content_view");
                content = contentElement ? contentElement.innerText.trim() : "네이트 스포츠 본문을 찾을 수 없습니다.";
                contentText = `${title}\n\n${content}`;
            }

            // ✅ 매일신문 처리
            else if (doc.querySelector("article#dic_area")) {
                title = doc.querySelector("meta[property='og:title']")?.content || doc.title;
                let contentElement = doc.querySelector("article#dic_area");
                content = contentElement ? contentElement.innerText.trim() : "본문을 찾을 수 없습니다.";
                contentText = `${title}\n\n${content}`;
            } 

            // ✅ 다음(Daum) 뉴스 본문 가져오기
            else if (doc.querySelector("#mArticle > div.news_view.fs_type1")) {
                title = doc.querySelector("meta[property='og:title']")?.content || doc.title;
                let contentElement = doc.querySelector("#mArticle > div.news_view.fs_type1");
                content = contentElement ? contentElement.innerText.trim() : "뉴스 본문을 찾을 수 없습니다.";
                contentText = `${title}\n\n${content}`;
            }

            // ✅ 경향신문 본문 가져오기
            else if (doc.querySelector("#articleBody")) {
                title = doc.querySelector("meta[property='og:title']")?.content || doc.title;
                let contentElement = doc.querySelector("#articleBody");
                const paragraphs = contentElement.querySelectorAll("p.content_text");
                if (paragraphs.length > 0) {
                    content = Array.from(paragraphs).map(p => p.innerText.trim()).join("\n\n");
                } else {
                    content = contentElement.innerText.trim();
                }
                contentText = `${title}\n\n${content}`;
            }

            // ✅ 조선일보 본문 가져오기
            else if (doc.querySelector("section.article-body")) {
                title = doc.querySelector("meta[property='og:title']")?.content || doc.title;
                let contentElement = doc.querySelector("section.article-body");
                const paragraphs = contentElement.querySelectorAll("p.article-body__content-text");
                if (paragraphs.length > 0) {
                    content = Array.from(paragraphs).map(p => p.innerText.trim()).join("\n\n");
                } else {
                    content = contentElement.innerText.trim();
                }
                contentText = `${title}\n\n${content}`;
            }

            // ✅ CNN 뉴스 처리
            else if (doc.querySelector(".article__content")) {
                title = doc.querySelector("meta[property='og:title']")?.content || doc.title;
                const paragraphs = doc.querySelectorAll(".article__content p");
                if (paragraphs.length > 0) {
                    content = Array.from(paragraphs)
                        .map(p => p.innerText.trim())
                        .filter(text => text.length > 0)
                        .join("\n\n");
                } else {
                    content = "CNN 본문을 찾을 수 없습니다.";
                }
                contentText = `${title}\n\n${content}`;
            }

            // ✅ 경기일보 기사 본문 크롤링
            else if (doc.querySelector(".article_cont_wrap")) {
                try {
                    title = doc.querySelector("meta[property='og:title']")?.content ||
                            doc.querySelector(".article_tit_wrap h3")?.innerText.trim() ||
                            doc.title || "경기일보 기사 제목 없음";

                    const bodyEl = doc.querySelector(".article_cont_wrap") || doc.querySelector(".article_cont");
                    content = bodyEl ? bodyEl.innerText.trim() : "경기일보 본문을 찾을 수 없습니다.";
                } catch (e) {
                    content = "경기일보 본문을 불러오는 중 오류 발생: " + e.message;
                }
                contentText = `${title}\n\n${content}`;
            }

            // ✅ 글로벌이코 기사 본문 크롤링
            else if (doc.querySelector(".vcon1, #articleBody, [itemprop='articleBody']")) {
                try {
                    title = doc.querySelector("meta[property='og:title']")?.content?.trim() ||
                            doc.querySelector("h1, .article_tit_wrap h1")?.innerText?.trim() ||
                            doc.title || "글로벌이코 기사 제목 없음";
                    title = title.replace(/\s*-\s*글로벌이코노믹\s*$/gi, "").trim();

                    const bodyEl = doc.querySelector("[itemprop='articleBody']") ||
                                   doc.querySelector("#articleBody") ||
                                   doc.querySelector(".vcon1") ||
                                   doc.querySelector(".vincon1");

                    if (bodyEl) {
                        content = bodyEl.innerText.trim();
                        content = content.replace(/[\uAC00-\uD7A3]{2,4}\s*글로벌이코노믹\s*기자\s*[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/gi, "")
                            .replace(/[\uAC00-\uD7A3]{2,4}\s*글로벌\s*$/gi, "")
                            .replace(/\[알림\][\s\S]*?(투자손실[^\n]*)/gi, "")
                            .replace(/헤드라인\s*뉴스[\s\S]*$/gi, "")
                            .replace(/Sponsored[\s\S]*$/gi, "")                         
                            .replace(/\n{2,}/g, "\n\n")
                            .trim();
                    } else {
                        content = "글로벌이코 본문을 찾을 수 없습니다.";
                    }
                } catch (e) {
                    content = "글로벌이코 본문을 불러오는 중 오류 발생: " + e.message;
                }
                contentText = `${title}\n\n${content}`;
            }

            // ✅ KBS 뉴스 기사 처리
            else if (doc.querySelector("#cont_newstext")) { 
                title = doc.querySelector("meta[property='og:title']")?.content || doc.title;
                let contentElement = doc.querySelector("#cont_newstext");
                let rawContent = contentElement ? contentElement.innerText.trim() : "KBS 뉴스 본문을 찾을 수 없습니다.";
                
                content = rawContent.replace(/[\r\n\s]*■\s*제보하기[\s\S]*$/gi, "").trim();
                content = content.replace(/[\r\n\s]*\[사진\s*출처\s*:[\s\S]*\]$/gi, "").trim();
                contentText = `${title}\n\n${content}`;
            }

            // ✅ YTN 뉴스 기사 처리
            else if (doc.querySelector("#CmAdContent")) {
                title = doc.querySelector("meta[property='og:title']")?.content || doc.title;
                let contentElement = doc.querySelector("#CmAdContent > span:first-child");
                content = contentElement ? contentElement.innerText.trim() : "YTN 뉴스 본문을 찾을 수 없습니다.";
                contentText = `${title}\n\n${content}`;
            }

            // ✅ MSN News (Microsoft Start) 처리
            else if (doc.querySelector("cp-article")) {
                title = doc.querySelector("meta[property='og:title']")?.content || doc.title;
                content = "MSN 본문을 찾을 수 없습니다."; 
                
                try {
                    const msnReader = doc.querySelㅇector('cp-article'); 
                    // 주의: DOMParser는 shadowRoot를 지원하지 않으므로, 이 로직은 content script 환경에서만 정상 작동할 수 있습니다.
                    if (msnReader && msnReader.shadowRoot) {
                        let shadowBody = msnReader.shadowRoot.querySelector('body.article-body.polished'); 
                        if (!shadowBody) {
                            shadowBody = msnReader.shadowRoot.querySelector('body');
                        }

                        if (shadowBody) {
                            const textElements = shadowBody.querySelectorAll('p, h1, h2, h3, h4, h5, h6');
                            const extractedLines = [];
                            
                            textElements.forEach(el => {
                                let text = el.innerText.trim();
                                if (text) {
                                    if (text.includes('실시간 인기기사') || el.closest('.article-list-slot')) {
                                        return; 
                                    }
                                    text = text.replace(/\[\d+위\s*\]/g, '').trim(); 
                                    extractedLines.push(text);
                                }
                            });
                                                
                            content = extractedLines.filter(Boolean).join("\n\n");
                            const unwantedIndex = content.indexOf('실시간 인기기사');
                            if (unwantedIndex !== -1) {
                                content = content.substring(0, unwantedIndex).trim();
                            }
                        }
                    }
                } catch (e) {
                    console.error("MSN Shadow DOM 크롤링 오류:", e);
                    content = "MSN 본문 분석 중 오류 발생: " + e.message;
                }
                contentText = `${title}\n\n${content}`;
            }














            // ✅✅✅ 여기에 naver_text_Crawling.js에 있던 다른 모든 사이트(티스토리, 유튜브, 뉴스 등)의 else if 블록들을 추가 ✅✅✅
            // (생략된 다른 파싱 로직들)
            
            else {
                // 어떤 사이트에도 해당하지 않을 경우의 기본 파싱 로직
                const containers = ['.se-main-container', '#postViewArea', '._postView', '.post-view', 'article', '#articleBody', '.article-body'];
                const root = containers.map(sel => doc.querySelector(sel)).find(Boolean) || doc.body;
                const textChunks = [];
                root.querySelectorAll('p, h2, h3, li, blockquote').forEach(el => {
                    const t = el.textContent.replace(/\s+/g, ' ').trim();
                    if (t) textChunks.push(t);
                });
                contentText = textChunks.join('\n\n');
            }
            
            sendResponse({ success: true, contentText: contentText });

        } catch (e) {
            sendResponse({ success: false, error: e.message });
        }
        return true; // 비동기 응답
    }



    // ✅ 6. 네이버 이미지 검색 결과 HTML 파싱
    else if (request.action === 'parseNaverImageSearch') {
        try {
            const doc = new DOMParser().parseFromString(request.html, "text/html");
            const imageContainer = doc.querySelector('.image_tile._fe_image_tab_grid');
            if (!imageContainer) {
                throw new Error("이미지 컨테이너를 찾을 수 없습니다.");
            }
            
            const jsonData = imageContainer.getAttribute('data-image-viewer-list');
            if (!jsonData) {
                throw new Error("이미지 JSON 데이터를 찾을 수 없습니다.");
            }
            
            const images = JSON.parse(jsonData);
            
            const results = images.map(img => ({
                thumb: img.thumb,
                originalUrl: img.originalUrl,
                title: img.title
            }));

            sendResponse({ success: true, data: results });

        } catch (e) {
            sendResponse({ success: false, error: e.message });
        }
        return true;
    }


    // ✅ 7. 클립보드에 이미지 쓰기 요청 처리
    else if (request.action === 'writeImageToClipboard') {
        (async () => {
            try {
                const response = await fetch(request.dataUrl);
                const blob = await response.blob();
                await navigator.clipboard.write([
                    new ClipboardItem({
                        [blob.type]: blob
                    })
                ]);
                sendResponse({ success: true });
            } catch (error) {
                console.error('Offscreen 클립보드 쓰기 실패:', error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true; // 비동기 응답
    }




    // ✅ 8. 네이버 순위 검증용 HTML 파싱 (DOMParser 오류 해결 최종 버전)
    else if (request.action === 'parseNaverRank') {
        try {
            const { html, blogId } = request;
            const doc = new DOMParser().parseFromString(html, "text/html");
            
            // [1] 네이버 VIEW 검색 결과의 각 아이템을 감싸는 컨테이너를 모두 선택합니다.
            const searchResults = doc.querySelectorAll('.total_wrap.api_ani_send');
            let foundRank = -1; 

            // [2] 각 결과 아이템을 순서대로 확인합니다.
            for (let i = 0; i < searchResults.length; i++) {
                const item = searchResults[i];
                // [3] 현재 아이템 내에 있는 모든 링크(a 태그)를 가져옵니다.
                const allLinksInItem = item.querySelectorAll('a'); 
                let foundMatch = false;

                // [4] (참고 코드 핵심 로직) 각 링크를 순회하며 href에 내 블로그 ID가 포함되어 있는지 확인합니다.
                for (const linkElement of allLinksInItem) {
                    if (linkElement && linkElement.href && linkElement.href.includes(`blog.naver.com/${blogId}`)) {
                        foundRank = i + 1; // 순위는 1부터 시작하므로 +1
                        foundMatch = true;
                        break; // 내 블로그 링크를 찾았으므로 더 이상 내부 링크를 확인할 필요가 없습니다.
                    }
                }

                if (foundMatch) {
                    break; // 최종 순위를 찾았으므로 다음 결과 아이템을 확인할 필요가 없습니다.
                }
            }
            
            sendResponse({ success: true, rank: foundRank });

        } catch (e) {
            sendResponse({ success: false, error: e.message });
        }
        return true; // 비동기 응답임을 알립니다.
    }

    // ✅ 9. 클립보드에 텍스트 쓰기 요청 처리 (쿠팡 파트너스 링크용)
    else if (request.action === 'writeTextToClipboard') {
        // Offscreen Document는 DOM API에 접근 가능하므로, 임시 textarea를 만들어 사용합니다.
        // navigator.clipboard.writeText는 사용자 상호작용이 필요할 수 있어 이 방식이 더 안정적입니다.
        const textarea = document.createElement('textarea');
        textarea.value = request.text;
        document.body.appendChild(textarea);
        textarea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textarea);

        if (success) {
            sendResponse({ success: true });
        } else {
            sendResponse({ success: false, error: 'document.execCommand("copy") failed.' });
        }
        return true; // 비동기 응답을 위해 true 반환
    }



    // ✅ 10. 카메라 저장 이미지에 EXIF 데이터 주입 요청 처리 (캔버스 변환 포함)
    else if (request.action === 'addExifToImage') {
        // 비동기 처리를 위해 즉시 실행 비동기 함수(IIFE) 사용
        (async () => {
            try {
                const { base64Image, exifSettings } = request;

                // piexif 라이브러리 로드 확인
                if (typeof piexif === 'undefined') {
                    throw new Error('piexif 라이브러리가 로드되지 않았습니다.');
                }

                // 1. 이미지를 로드하고 캔버스를 통해 JPEG로 변환 (필수 과정)
                // (EXIF는 JPEG 표준이므로 PNG 등은 이 과정을 거쳐야 합니다.)
                const jpegDataUrl = await new Promise((resolve, reject) => {
                    const img = new Image();
                    img.onload = () => {
                        try {
                            const canvas = document.createElement('canvas');
                            canvas.width = img.width;
                            canvas.height = img.height;
                            const ctx = canvas.getContext('2d');
                            
                            // 투명 배경 처리 (PNG -> JPEG 변환 시 검은 배경 방지)
                            ctx.fillStyle = '#FFFFFF';
                            ctx.fillRect(0, 0, canvas.width, canvas.height);
                            
                            ctx.drawImage(img, 0, 0);
                            
                            // 최고 화질(1.0)의 JPEG로 변환
                            resolve(canvas.toDataURL('image/jpeg', 1.0));
                        } catch (err) {
                            reject(err);
                        }
                    };
                    img.onerror = () => reject(new Error('이미지 로드 실패'));
                    img.src = base64Image;
                });

                // 2. 숫자/비율 변환 헬퍼 함수들
                const toRational = (num) => {
                    const n = parseFloat(num);
                    if (isNaN(n)) return [0, 1];
                    const decimal = n.toString().split('.')[1];
                    const denominator = decimal ? Math.pow(10, decimal.length) : 1;
                    return [Math.round(n * denominator), denominator];
                };
                
                const toExposure = (str) => {
                    if (str && str.includes('/')) {
                        const parts = str.split('/');
                        return [parseInt(parts[0]), parseInt(parts[1])];
                    }
                    return toRational(str);
                };

                const now = new Date();
                const dateStr = now.getFullYear() + ":" + 
                            ("0" + (now.getMonth() + 1)).slice(-2) + ":" + 
                            ("0" + now.getDate()).slice(-2) + " " + 
                            ("0" + now.getHours()).slice(-2) + ":" + 
                            ("0" + now.getMinutes()).slice(-2) + ":" + 
                            ("0" + now.getSeconds()).slice(-2);

                // 3. EXIF 객체 생성 (모든 요청 속성 추가됨)
                const exifObj = {
                    "0th": {
                        [piexif.ImageIFD.Make]: exifSettings.make || "Samsung",
                        [piexif.ImageIFD.Model]: exifSettings.model || "Galaxy S24 Ultra",
                        [piexif.ImageIFD.Software]: exifSettings.software || "S928NKSS4BYG8",
                        [piexif.ImageIFD.DateTime]: dateStr,
                        [piexif.ImageIFD.XPTitle]: [104, 0, 101, 0, 108, 0, 108, 0, 111, 0], // Windows Title
                    },
                    "Exif": {
                        [piexif.ExifIFD.ExifVersion]: "0220", // EXIF 버전
                        [piexif.ExifIFD.DateTimeOriginal]: dateStr,
                        [piexif.ExifIFD.DateTimeDigitized]: dateStr,
                        [piexif.ExifIFD.ISOSpeedRatings]: parseInt(exifSettings.iso) || 160,
                        [piexif.ExifIFD.FNumber]: toRational(exifSettings.fstop || 1.7),
                        [piexif.ExifIFD.ExposureTime]: toExposure(exifSettings.exposure || "1/180"),
                        [piexif.ExifIFD.ExposureBiasValue]: toRational(0), // 노출 바이어스
                        [piexif.ExifIFD.MaxApertureValue]: toRational(1.53), // 조리개 최대 개방
                        [piexif.ExifIFD.MeteringMode]: 2, // 측광 모드 (중앙)
                        [piexif.ExifIFD.LightSource]: 0, // 광원
                        [piexif.ExifIFD.Flash]: 0, // 플래시 끔
                        [piexif.ExifIFD.FocalLength]: toRational(exifSettings.focal || 6),
                        [piexif.ExifIFD.ImageUniqueID]: "HK0XLQE00SM", // 이미지 ID
                        [piexif.ExifIFD.ExposureProgram]: 2, // 노출 프로그램
                        [piexif.ExifIFD.BrightnessValue]: toRational(3.69), // 밝기
                        [piexif.ExifIFD.DigitalZoomRatio]: toRational(1), // 디지털 확대/축소
                        [piexif.ExifIFD.FocalLengthIn35mmFilm]: parseInt(exifSettings.focal35) || 23,
                        [piexif.ExifIFD.WhiteBalance]: 0, // 화이트 밸런스
                    }
                };

                // 4. EXIF 바이너리 생성 및 삽입
                const exifBytes = piexif.dump(exifObj);
                
                // 주의: 여기서 반드시 변환된 'jpegDataUrl'을 사용해야 합니다.
                const newBase64 = piexif.insert(exifBytes, jpegDataUrl);

                sendResponse({ success: true, data: newBase64 });

            } catch (e) {
                // console.error("Offscreen EXIF Error:", e);
                sendResponse({ success: false, error: e.message }); 
            }
        })();
        
        return true; // 비동기 응답 유지를 위해 필수
    }


    // ✅ 11. 티스토리 리스트 파싱 로직 (DOMParser 사용)
    else if (request.action === 'parseTistoryList') {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(request.html, "text/html");
            const posts = [];
            const baseUrl = request.baseUrl;

            // 파이썬 코드의 선택자 로직을 JS 배열로 정의 (다양한 스킨 대응)
            const extractStrategies = [
                { container: "div.post-item", title: "span.title", link: "a[href]", date: "span.date" },
                { container: "article.article-type-common", title: "strong.title", link: "a.link-article", date: "span.date" },
                { container: "div#searchList ol li", title: "a", link: "a", date: "span.date" },
                { container: "div.content_article_rep > div.inner_content > a.link_thumb", title: "strong.txt_title", link: null, date: "span.date", selfLink: true },
                { container: "div.list_content a.post_link", title: "h2.post_title", link: null, date: "div.post_date", selfLink: true },
                { container: "div#searchList li#listset", title: "a", link: "a", date: null },
                { container: "li.item_category a.link_category", title: "strong.name", link: null, date: "span.date", selfLink: true },
                { container: "div.post-item", title: "h2.title a", link: "h2.title a", date: "span.date" },
                { container: "li.list_horizontal_item", title: "strong.title_post", link: "a.link_title", date: "span.date" }
            ];

            // 전략 순회
            for (const strategy of extractStrategies) {
                const elements = doc.querySelectorAll(strategy.container);
                if (elements.length > 0) {
                    elements.forEach(el => {
                        let titleEl, linkEl, dateEl;

                        if (strategy.selfLink) {
                            linkEl = el;
                            titleEl = el.querySelector(strategy.title);
                        } else {
                            titleEl = strategy.title ? el.querySelector(strategy.title) : el;
                            linkEl = strategy.link ? el.querySelector(strategy.link) : el;
                        }
                        dateEl = strategy.date ? el.querySelector(strategy.date) : null;

                        if (titleEl && linkEl) {
                            let title = titleEl.innerText.trim();
                            let link = linkEl.getAttribute("href");
                            let date = dateEl ? dateEl.innerText.trim() : "날짜 정보 없음";

                            if (link && link.startsWith("/")) {
                                link = baseUrl + link;
                            }

                            date = date.replace(/[^0-9.]/g, ''); 
                            if(date.endsWith('.')) date = date.slice(0, -1);

                            if (!posts.some(p => p.link === link)) {
                                posts.push({ title, link, date });
                            }
                        }
                    });
                    if (posts.length > 0) break;
                }
            }
            sendResponse({ success: true, data: posts });
        } catch (e) {
            sendResponse({ success: false, error: e.message });
        }
        return true;
    }



    // ✅ 12. 블로그스팟 리스트 파싱 로직
    else if (request.action === 'parseBlogspotList') {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(request.html, "text/html");
            const posts = [];
            
            // 파이썬 코드의 5가지 구조 반영
            const selectors = [
                "div.widget.FeaturedPost article.post", // 구조 1
                "div.post",                             // 구조 1 일반
                "article.post",                         // 구조 2
                "article",                              // 구조 3~4
                "div.index-post"                        // 구조 5
            ];
            
            // 모든 선택자의 결과를 합칩니다 (중복 제거는 나중에 링크 기준으로 수행)
            let allElements = [];
            selectors.forEach(sel => {
                const els = doc.querySelectorAll(sel);
                if (els.length > 0) allElements = [...allElements, ...Array.from(els)];
            });

            // Set을 사용하여 중복 요소 처리 (링크 기준)
            const seenLinks = new Set();

            allElements.forEach(post => {
                let title = null;
                let link = null;
                let date = "날짜 정보 없음";

                // 구조별 제목/링크 추출 시도
                const titleStrategies = [
                    { t: "h3.post-title a", l: "h3.post-title a" },
                    { t: "h2.post-title.entry-title a", l: "h2.post-title.entry-title a" },
                    { t: "h2.post-title a", l: "h2.post-title a" },
                    { t: "h2.retitle a", l: "h2.retitle a" },
                    { t: "h2.entry-title a.entry-title-link", l: "h2.entry-title a.entry-title-link" },
                    { t: "h2 > a", l: "h2 > a" }
                ];

                for (const s of titleStrategies) {
                    const tEl = post.querySelector(s.t);
                    const lEl = post.querySelector(s.l);
                    if (tEl && lEl) {
                        title = tEl.innerText.trim();
                        link = lEl.getAttribute("href").trim();
                        break;
                    }
                }

                if (!title || !link || seenLinks.has(link)) return;

                // 날짜 추출
                const dateTag = post.querySelector("time.published") || 
                                post.querySelector("time.published.updated") || 
                                post.querySelector("span.post-date.published");
                
                if (dateTag && dateTag.getAttribute("datetime")) {
                    try {
                        const rawDate = dateTag.getAttribute("datetime");
                        const d = new Date(rawDate);
                        date = `${String(d.getFullYear()).slice(2)}년${d.getMonth() + 1}월${d.getDate()}일`;
                    } catch (e) {
                        // 날짜 파싱 실패 시 원본 텍스트 사용 시도
                        date = dateTag.innerText.trim();
                    }
                } else if (dateTag) {
                     date = dateTag.innerText.trim();
                }

                seenLinks.add(link);
                posts.push({ title, link, date });
            });

            // 다음 페이지 링크 추출(next_link)
            const nextLinkEl = doc.querySelector("a.blog-pager-older-link.load-more.btn") ||
                               doc.querySelector("a.blog-pager-older-link") ||
                               doc.querySelector("a[href*='updated-max']");
            
            let nextUrl = null;
            if (nextLinkEl) {
                // data-load 속성이나 href 속성 사용
                nextUrl = nextLinkEl.getAttribute("data-load") || nextLinkEl.getAttribute("href");
            }

            sendResponse({ success: true, data: posts, nextUrl: nextUrl });

        } catch (e) {
            sendResponse({ success: false, error: e.message });
        }
        return true;
    }

    // ✅ 13. 워드프레스 리스트 파싱 로직 추가
    else if (request.action === 'parseWordpressList') {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(request.html, "text/html");
            const posts = [];
            
            // 워드프레스 확인 (wp-content 또는 wp-includes 문자열 확인)
            const htmlString = request.html;
            const isWordpress = htmlString.includes('wp-content') || htmlString.includes('wp-includes');

            // 워드프레스 테마별 다양한 선택자 전략
            const strategies = [
                // Standard Semantic HTML5
                { container: "article", title: ".entry-title a, h1 a, h2 a", date: ".entry-date, time.published, .date" },
                // Classic Layouts
                { container: ".post", title: ".post-title a, h2 a", date: ".post-date, .date" },
                { container: ".type-post", title: ".entry-title a", date: ".updated, .published" },
                // GeneratePress & Common Themes
                { container: "article.post", title: "h2.entry-title a", date: ".entry-date" },
                // Elementor Loop Grid
                { container: ".elementor-post", title: ".elementor-post__title a", date: ".elementor-post__date" },
                // Generic Fallback
                { container: ".blog-post", title: "h2 a", date: ".date" },
                { container: "div[id^='post-']", title: "h2 a", date: "time" }
            ];

            // 선택자들을 순회하며 데이터 추출 시도
            let extracted = false;
            for (const s of strategies) {
                const elements = doc.querySelectorAll(s.container);
                if (elements.length > 0) {
                    elements.forEach(el => {
                        const titleEl = el.querySelector(s.title);
                        // 링크가 제목에 없으면 컨테이너 자체나 별도 더보기 버튼 확인
                        const linkEl = titleEl || el.querySelector('a.read-more') || el.querySelector('a'); 
                        const dateEl = el.querySelector(s.date);

                        if (titleEl && linkEl) {
                            const title = titleEl.innerText.trim();
                            const link = linkEl.getAttribute("href");
                            let date = "날짜 정보 없음";

                            // 날짜 추출 시도
                            if (dateEl) {
                                date = dateEl.innerText.trim();
                                if (dateEl.getAttribute("datetime")) {
                                    date = dateEl.getAttribute("datetime").split('T')[0];
                                }
                            }

                            if (title && link) {
                                posts.push({ title, link, date });
                            }
                        }
                    });

                    if (posts.length > 0) {
                        extracted = true;
                        break; // 성공적으로 추출했으면 루프 중단
                    }
                }
            }

            sendResponse({ success: true, data: posts, isWordpress: isWordpress });

        } catch (e) {
            sendResponse({ success: false, error: e.message });
        }
        return true;
    }

    // ✅ 14. 구글 뉴스 검색 결과 파싱 (상위 2개 링크 추출): 트렌드 키워드 네이버 자동 포스팅
    else if (request.action === 'parseGoogleNewsResult') {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(request.html, "text/html");
            
            // 구글 뉴스 기사 링크 선택자 (사용자가 제공한 구조 기반)
            // class="JtKRv" 또는 href가 "./read/"로 시작하는 태그
            const linkElements = Array.from(doc.querySelectorAll('a.JtKRv, a[href^="./read/"]'));
            
            const links = [];
            const uniqueLinks = new Set();

            for (const el of linkElements) {
                let href = el.getAttribute('href');
                if (href && href.startsWith('./')) {
                    // 상대 경로를 절대 경로로 변환
                    href = 'https://news.google.com' + href.substring(1);
                }
                
                // 중복 제거 및 최대 2개까지만 수집
                if (href && !uniqueLinks.has(href)) {
                    uniqueLinks.add(href);
                    links.push(href);
                }
                
                if (links.length >= 2) break; // 상위 2개만
            }

            sendResponse({ success: true, links: links });
        } catch (e) {
            sendResponse({ success: false, error: e.message });
        }
        return true;
    }


    // ✅ 15. 구글 뉴스 검색 결과 파싱 (상위 1개 링크 추출): 네이버 실시간 뉴스 주제 추천, 네이버 & 구글 트렌드 키워드 추출
    else if (request.action === 'parseGoogleNewsResult') {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(request.html, "text/html");
            
            // 구글 뉴스 기사 링크 선택자 (JtKRv 클래스 또는 ./read/ 경로)
            // 2024년 기준 구글 뉴스 구조에 맞춤
            const linkElements = Array.from(doc.querySelectorAll('a.JtKRv, a[href^="./read/"]'));
            
            const links = [];
            const uniqueLinks = new Set();

            for (const el of linkElements) {
                let href = el.getAttribute('href');
                if (href && href.startsWith('./')) {
                    // 상대 경로를 절대 경로로 변환
                    href = 'https://news.google.com' + href.substring(1);
                }
                
                // 중복 제거 및 유효성 확인
                if (href && !uniqueLinks.has(href)) {
                    uniqueLinks.add(href);
                    links.push(href);
                }
                
                if (links.length >= 1) break; // 가장 상위 1개만 추출
            }

            sendResponse({ success: true, links: links });
        } catch (e) {
            sendResponse({ success: false, error: e.message });
        }
        return true;
    }

    

});



// --- 사운드 재생 함수들 ---

function playShortNotificationSound() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') audioContext.resume();
        const melody = [
            { freq: 523, duration: 0.1 }, { freq: 659, duration: 0.1 },
            { freq: 784, duration: 0.1 }, { freq: 1046, duration: 0.2 },
        ];
        playSoundMelody(audioContext, melody, 0.05);
    } catch (e) {
        console.warn('⚠️ 사운드 재생 실패:', e);
    }
}

function playCompletionMelody() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') audioContext.resume();
        const melody = [
            { freq: 523, duration: 0.4 }, { freq: 659, duration: 0.4 },
            { freq: 784, duration: 0.4 }, { freq: 1046, duration: 0.6 },
            { freq: 784, duration: 0.4 }, { freq: 659, duration: 0.4 },
            { freq: 523, duration: 0.4 }, { freq: 392, duration: 0.6 },
            { freq: 523, duration: 0.4 }, { freq: 659, duration: 0.4 },
            { freq: 784, duration: 0.4 }, { freq: 1046, duration: 1.2 },
        ];
        playSoundMelody(audioContext, melody, 0.1);
    } catch (e) {
        console.warn('⚠️ 사운드 재생 실패:', e);
    }
}

function playUrgentSirenSound() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') audioContext.resume();
        const melody = [
            { freq: 932, duration: 0.3 }, { freq: 784, duration: 0.3 },
            { freq: 932, duration: 0.3 }, { freq: 784, duration: 0.3 },
            { freq: 932, duration: 0.3 }, { freq: 784, duration: 0.3 },
        ];
        playSoundMelody(audioContext, melody, 0.05);
    } catch (e) {
        console.warn('⚠️ 사운드 재생 실패:', e);
    }
}

function playErrorSound() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') audioContext.resume();
        const melody = [
            { freq: 440, duration: 0.3 }, { freq: 0, duration: 0.15 },
            { freq: 440, duration: 0.4 }, { freq: 0, duration: 0.15 },
            { freq: 440, duration: 0.4 },
        ];
        playSoundMelody(audioContext, melody, 0.05);
    } catch (e) {
        console.warn('⚠️ 오류 사운드 재생 실패:', e);
    }
}

function playSoundMelody(audioContext, melody, interval) {
    let currentTime = audioContext.currentTime;
    melody.forEach(note => {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = note.freq;
        gainNode.gain.setValueAtTime(0.15, currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, currentTime + note.duration);
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        oscillator.start(currentTime);
        oscillator.stop(currentTime + note.duration);
        currentTime += note.duration + interval;
    });
}

////////////////////////////////////////////////////////////// ✅ 알람 사운드 코드_ 종료////////////////////////////////////////////////


// ✅5️⃣ manifest.json파일 permissions 부분에 notifications, alarms, offscreen 페이지 추가 해야함!
  // "permissions": [
  //   "notifications",
  //   "alarms",
  //   "offscreen"
  // ],