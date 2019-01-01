(function() {
    // umd规范实现
    const out$ = typeof exports != 'undefined' && exports || typeof define != 'undefined' && {} || this || window;
    if (typeof define !== 'undefined') define('save-svg-as-png', [], () => out$);
  
    // The prefix xmlns: was specified as a syntactic device for declaring namespaces, but was not itself associated with any namespace name by the Jan 1999 namespaces specification. But in some processing contexts, e.g. DOM, it is useful to represent all XML attributes as (namespace name, local name) pairs. For this purpose, the namespace name http://www.w3.org/2000/xmlns/ is assigned
    const xmlns = 'http://www.w3.org/2000/xmlns/';

    // dvg的xml根
    const doctype = '<?xml version="1.0" standalone="no"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [<!ENTITY nbsp "&#160;">]>';
    // url的正则
    const urlRegex = /url\(["']?(.+?)["']?\)/;
    // 一些字体文件的Mime
    const fontFormats = {
      woff2: 'font/woff2',
      woff: 'font/woff',
      otf: 'application/x-font-opentype',
      ttf: 'application/x-font-ttf',
      eot: 'application/vnd.ms-fontobject',
      sfnt: 'application/font-sfnt',
      svg: 'image/svg+xml'
    };
  
    // 是否是元素，这里也包含DOM元素？
    const isElement = obj => obj instanceof HTMLElement || obj instanceof SVGElement;
    // 不是元素抛异常
    const requireDomNode = el => {
      if (!isElement(el)) throw new Error(`an HTMLElement or SVGElement is required; got ${el}`);
    };
    // ??? 根据上下文认为该函数是判断url是否有后缀名，但是判断方法完全不对
    const isExternal = url => url && url.lastIndexOf('http',0) === 0 && url.lastIndexOf(window.location.host) === -1;
  
    // 根据url获得字体的mime 
    const getFontMimeTypeFromUrl = fontUrl => {
      // 检索通过url的扩展名确定mime类型
      const formats = Object.keys(fontFormats)
        // 用endsWith代替indexOf更合适
        .filter(extension => fontUrl.indexOf(`.${extension}`) > 0)
        .map(extension => fontFormats[extension]);
      if (formats) return formats[0];
      // 没找到直接返回'application/octet-stream'
      console.error(`Unknown font format for ${fontUrl}. Fonts may not be working correctly.`);
      return 'application/octet-stream';
    };
  
    // 把arrabuffer转为base64
    const arrayBufferToBase64 = buffer => {
      let binary = '';
      const bytes = new Uint8Array(buffer);
      // 8位是一字节，一字节一字节地把二进制转为ascii码
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      // 使用base64将字节转为base64
      return window.btoa(binary);
    }
  
    /**
     * 获取距离大小
     * @param {*} el        获取元素
     * @param {*} clone     这里为什么要克隆？因为访问克隆的属性效率更高，在getImage里面一定要克隆，所以这里用clone效率更高
     * @param {*} dim       尺寸的属性名，比如width、height
     */
    const getDimension = (el, clone, dim) => {
      const v =
        // 如果el是svg，会有类型是SVGAnimatedRect的viewbox属性
        (el.viewBox && el.viewBox.baseVal && el.viewBox.baseVal[dim]) ||
        // 从clone的属性中获取，要求不能是百分数的形式
        (clone.getAttribute(dim) !== null && !clone.getAttribute(dim).match(/%$/) && parseInt(clone.getAttribute(dim))) ||
        // 使用getBoundingClientRect获取
        el.getBoundingClientRect()[dim] ||
        // 使用style获取
        parseInt(clone.style[dim]) ||
        // 使用getComputedStyle获取
        parseInt(window.getComputedStyle(el).getPropertyValue(dim));
      return typeof v === 'undefined' || v === null || isNaN(parseFloat(v)) ? 0 : v;
    };
    
    // 获取element的宽和高
    const getDimensions = (el, clone, width, height) => {
      if (el.tagName === 'svg') return {
        width: width || getDimension(el, clone, 'width'),
        height: height || getDimension(el, clone, 'height')
      };
      // 如果是svg元素，有getBBox，使用getBBox获取尺寸
      else if (el.getBBox) {
        const {x, y, width, height} = el.getBBox();
        return {
          width: x + width,
          height: y + height
        };
      }
    };
  
    const reEncode = data =>
      decodeURIComponent(
        encodeURIComponent(data)
          .replace(/%([0-9A-F]{2})/g, (match, p1) => {
            const c = String.fromCharCode(`0x${p1}`);
            return c === '%' ? '%25' : c;
          })
      );
  
    const uriToBlob = uri => {
      const byteString = window.atob(uri.split(',')[1]);
      const mimeString = uri.split(',')[0].split(':')[1].split(';')[0]
      const buffer = new ArrayBuffer(byteString.length);
      const intArray = new Uint8Array(buffer);
      for (let i = 0; i < byteString.length; i++) {
        intArray[i] = byteString.charCodeAt(i);
      }
      return new Blob([buffer], {type: mimeString});
    };
  
    const query = (el, selector) => {
      if (!selector) return;
      try {
        return el.querySelector(selector) || el.parentNode && el.parentNode.querySelector(selector);
      } catch(err) {
        console.warn(`Invalid CSS selector "${selector}"`, err);
      }
    };
  
    const detectCssFont = (rule, href) => {
      // Match CSS font-face rules to external links.
      // @font-face {
      //   src: local('Abel'), url(https://fonts.gstatic.com/s/abel/v6/UzN-iejR1VoXU2Oc-7LsbvesZW2xOQ-xsNqO47m55DA.woff2);
      // }
      const match = rule.cssText.match(urlRegex);
      const url = (match && match[1]) || '';
      if (!url || url.match(/^data:/) || url === 'about:blank') return;
      const fullUrl =
        url.startsWith('../') ? `${href}/../${url}`
        : url.startsWith('./') ? `${href}/.${url}`
        : url;
      return {
        text: rule.cssText,
        format: getFontMimeTypeFromUrl(fullUrl),
        url: fullUrl
      };
    };
  
    /**
     * 加载元素的图片，用promise.all并行加载。该函数有个问题，就是相同的url无论出现几次都会加载一图片，效率很低
     * 不是很理解这个函数的用意，加载的图片没有返回，仅能是确保每一个图片都能访问到
     * el {类数组，如ElementList}           element数组
     */
    const inlineImages = el => Promise.all(
      Array.from(el.querySelectorAll('image')).map(image => {
        let href = image.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || image.getAttribute('href');
        if (!href) return Promise.resolve(null);
        // 加上时间戳，去除缓存
        if (isExternal(href)) {
          href += (href.indexOf('?') === -1 ? '?' : '&') + 't=' + new Date().valueOf();
        }
        return new Promise((resolve, reject) => {
          const canvas = document.createElement('canvas');
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.src = href;
          img.onerror = () => reject(new Error(`Could not load ${href}`));
          img.onload = () => {
            canvas.width = img.width;
            canvas.height = img.height;
            canvas.getContext('2d').drawImage(img, 0, 0);
            // 用base64放到一个image里面
            image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', canvas.toDataURL('image/png'));
            resolve(true);
          };
        });
      })
    );
  
    // 加载字体（并缓存）
    const cachedFonts = {};
    const inlineFonts = fonts => Promise.all(
      fonts.map(font =>
        new Promise((resolve, reject) => {
          // 如果有缓存返回缓存
          if (cachedFonts[font.url]) return resolve(cachedFonts[font.url]);
  
          // 用ajax加载字体（注意跨域）
          const req = new XMLHttpRequest();
          req.addEventListener('load', () => {
            // TODO: it may also be worth it to wait until fonts are fully loaded before
            // attempting to rasterize them. (e.g. use https://developer.mozilla.org/en-US/docs/Web/API/FontFaceSet)

            // 生成字体缓存
            const fontInBase64 = arrayBufferToBase64(req.response);
            const fontUri = font.text.replace(urlRegex, `url("data:${font.format};base64,${fontInBase64}")`)+'\n';
            cachedFonts[font.url] = fontUri;
            resolve(fontUri);
          });
          // error和abort的情况，加载失败
          req.addEventListener('error', e => {
            console.warn(`Failed to load font from: ${font.url}`, e);
            cachedFonts[font.url] = null;
            resolve(null);
          });
          req.addEventListener('abort', e => {
            console.warn(`Aborted loading font from: ${font.url}`, e);
            resolve(null);
          });
          req.open('GET', font.url);
          req.responseType = 'arraybuffer';
          req.send();
        })
      )
    ).then(fontCss => fontCss.filter(x => x).join(''));
  
    // 健壮样式表
    let cachedRules = null;
    const styleSheetRules = () => {
      if (cachedRules) return cachedRules;
      return cachedRules = Array.from(document.styleSheets).map(sheet => {
        try {
          return {rules: sheet.cssRules, href: sheet.href};
        } catch (e) {
          console.warn(`Stylesheet could not be loaded: ${sheet.href}`, e);
          return {};
        }
      });
    };
  
    const inlineCss = (el, options) => {
      const {
        selectorRemap,
        modifyStyle,
        modifyCss,
        fonts
      } = options || {};
      const generateCss = modifyCss || ((selector, properties) => {
        const sel = selectorRemap ? selectorRemap(selector) : selector;
        const props = modifyStyle ? modifyStyle(properties) : properties;
        return `${sel}{${props}}\n`;
      });
      const css = [];
      const detectFonts = typeof fonts === 'undefined';
      const fontList = fonts || [];
      styleSheetRules().forEach(({rules, href}) => {
        if (!rules) return;
        Array.from(rules).forEach(rule => {
          if (typeof rule.style != 'undefined') {
            if (query(el, rule.selectorText)) css.push(generateCss(rule.selectorText, rule.style.cssText));
            else if (detectFonts && rule.cssText.match(/^@font-face/)) {
              const font = detectCssFont(rule, href);
              if (font) fontList.push(font);
            } else css.push(rule.cssText);
          }
        });
      });
  
      return inlineFonts(fontList).then(fontCss => css.join('\n') + fontCss);
    };
  
    /**
     * 转换前准备工作，就是用将svg克隆，然后把克隆后的DOM转换为一个标准的svg文档
     * @param {element} el          svg
     * @param {objec}   options     配置
     * @param {function}   done           回调函数
     */
    out$.prepareSvg = (el, options, done) => {
      // 判断是否是svg
      requireDomNode(el);
      const {
        left = 0,
        top = 0,
        // 简写成wh，为了节省字符数，简写输出体积？？？
        width: w,
        height: h,
        scale = 1,
        responsive = false,
      } = options || {};
  
      return inlineImages(el).then(() => {
        // 
        let clone = el.cloneNode(true);
        const {backgroundColor = 'transparent'} = options || {};
        clone.style.backgroundColor = backgroundColor;
        const {width, height} = getDimensions(el, clone, w, h);
  
        // 确保el是以svg为跟元素
        if (el.tagName !== 'svg') {
          // 如果是svg标签，会有getBBox函数
          if (el.getBBox) {
            // 移除transform的translate属性，确保坐标在0,0点
            clone.setAttribute('transform', clone.getAttribute('transform').replace(/translate\(.*?\)/, ''));
            const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
            svg.appendChild(clone);
            clone = svg;
          } else {
            console.error('Attempted to render non-SVG element', el);
            return;
          }
        }
  
        // 设置svg标签的版本、ns
        clone.setAttribute('version', '1.1');
        clone.setAttribute('viewBox', [left, top, width, height].join(' '));
        if (!clone.getAttribute('xmlns')) clone.setAttributeNS(xmlns, 'xmlns', 'http://www.w3.org/2000/svg');
        if (!clone.getAttribute('xmlns:xlink')) clone.setAttributeNS(xmlns, 'xmlns:xlink', 'http://www.w3.org/1999/xlink');
  
        // 是否使用自适应
        if (responsive) {
          clone.removeAttribute('width');
          clone.removeAttribute('height');
          // 如果是自使用，确保宽高比保持不变，viewBox会缩放以适应viewport的大小，并且左上角在0,0点
          clone.setAttribute('preserveAspectRatio', 'xMinYMin meet');
        } else {
          clone.setAttribute('width', width * scale);
          clone.setAttribute('height', height * scale);
        }
  
        // foreignObject元素可以让svg嵌入xhtml
        Array.from(clone.querySelectorAll('foreignObject > *')).forEach(foreignObject => {
          if (!foreignObject.getAttribute('xmlns'))
            foreignObject.setAttributeNS(xmlns, 'xmlns', 'http://www.w3.org/1999/xhtml');
        });
  
        return inlineCss(el, options).then(css => {
          // 处理行内的css，把他以一个style标签，放到svg里面
          const style = document.createElement('style');
          style.setAttribute('type', 'text/css');
          style.innerHTML = `<![CDATA[\n${css}\n]]>`;
  
          const defs = document.createElement('defs');
          defs.appendChild(style);
          clone.insertBefore(defs, clone.firstChild);
  
          // 用一个div，把clone包起来，然后就可以用innerHTML获得整个文档
          const outer = document.createElement('div');
          outer.appendChild(clone);
          const src = outer.innerHTML.replace(/NS\d+:href/gi, 'xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href');
  
          if (typeof done === 'function') done(src, width, height);
          else return {src, width, height};
        });
      });
    };
  
    out$.svgAsDataUri = (el, options, done) => {
      // 判断是否是svg
      requireDomNode(el);
      const result = out$.prepareSvg(el, options)
        .then(({src, width, height}) => {
            // 核心语句：将经过prepareSvg处理的文档，转为data64格式
            const svgXml = `data:image/svg+xml;base64,${window.btoa(reEncode(doctype+src))}`;
            if (typeof done === 'function') {
                done(svgXml, width, height);
            }
            return svgXml;
        });
      return result;
    };
  
    // 
    out$.svgAsPngUri = (el, options, done) => {
      // 判断是否是svg
      requireDomNode(el);
      const {
        encoderType = 'image/png',
        encoderOptions = 0.8,
        canvg
      } = options || {};
  
      /**
       * 核心的转换函数
       * @param {string} src      svg转为的base64字符串
       * @param {number} width    
       * @param {number} height   
       */
      const convertToPng = ({src, width, height}) => {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');

        // 这里用物理像素？？？为什么不用逻辑像素？？？ 为了保证显示的清晰度吗？
        const pixelRatio = window.devicePixelRatio || 1;
  
        canvas.width = width * pixelRatio;
        canvas.height = height * pixelRatio;
        canvas.style.width = `${canvas.width}px`;
        canvas.style.height = `${canvas.height}px`;

        // 修改放大倍数
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  
        if (canvg) canvg(canvas, src);
        else context.drawImage(src, 0, 0);
  
        // 将canvas转为base64的dataURL，然后
        let png;
        try {
          // 这里用了toDataURL，建议用getImageData，如何使用pngjs这种png库去转换，能够突破DataURL长度的限制
          png = canvas.toDataURL(encoderType, encoderOptions);
        } catch (e) {
          if ((typeof SecurityError !== 'undefined' && e instanceof SecurityError) || e.name === 'SecurityError') {
            console.error('Rendered SVG images cannot be downloaded in this browser.');
            return;
          } else throw e;
        }
        if (typeof done === 'function') done(png, canvas.width, canvas.height);
        return Promise.resolve(png);
      }
  
      if (canvg) return out$.prepareSvg(el, options).then(convertToPng);
      else return out$.svgAsDataUri(el, options).then(uri => {
        return new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(convertToPng({
            src: image,
            width: image.width,
            height: image.height
          }));
          image.onerror = () => {
            reject(`There was an error loading the data URI as an image on the following SVG\n${window.atob(uri.slice(26))}Open the following link to see browser's diagnosis\n${uri}`);
          }
          image.src = uri;
        })
      });
    };
  
    out$.download = (name, uri) => {
      //  下载
      // 微软的浏览支持msSaveOrOpenBlob。把uri编程一个blob文件
      if (navigator.msSaveOrOpenBlob) navigator.msSaveOrOpenBlob(uriToBlob(uri), name);
      else {
        const saveLink = document.createElement('a');
        // 如果a标签支持h5.1的download属性，使用该属性
        if ('download' in saveLink) {
          saveLink.download = name;
          saveLink.style.display = 'none';
          document.body.appendChild(saveLink);
          try {
            const blob = uriToBlob(uri);
            const url = URL.createObjectURL(blob);
            saveLink.href = url;
            saveLink.onclick = () => requestAnimationFrame(() => URL.revokeObjectURL(url));
          } catch (e) {
            console.warn('This browser does not support object URLs. Falling back to string URL.');
            saveLink.href = uri;
          }
          saveLink.click();
          document.body.removeChild(saveLink);
        }
        else {
          // 使用open打开
          window.open(uri, '_temp', 'menubar=no,toolbar=no,status=no');
        }
      }
    };
  
    out$.saveSvg = (el, name, options) => {
      // 判断是否是svg
      requireDomNode(el);
      out$.svgAsDataUri(el, options || {}, uri => out$.download(name, uri));
    };
  
    out$.saveSvgAsPng = (el, name, options) => {
      // 判断是否是svg
      requireDomNode(el);
      out$.svgAsPngUri(el, options || {}, uri => out$.download(name, uri));
    };
  })();
