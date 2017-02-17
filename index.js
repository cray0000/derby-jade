var jade  = require('jade');
var coffee = require('./coffee');
var crypto = require('crypto');
var path = require('path');
var fs = require('fs');
var os = require('os');
//process.env.DEBUG = 'derby-jade';
var debug = require('debug')('derby-jade');
var options;
var defaultIndent = 2;
//process.platform = 'win32';
var newLine = '\n';
var regNewLine = '\\n';

function r(pattern, modifiers) {
  return new RegExp(pattern, modifiers);
}

module.exports = function (app, opts) {
  options = opts || {};
  app.viewExtensions.push('.jade');
  app.compilers['.jade'] = compiler;
};

function addindent(source, count) {
  if (count === undefined) count = defaultIndent;
  var indentation = '';
  for (var i = 0; i < count; i++) {
    indentation += ' ';
  }
  return indentation + source;
}

function preprocess(source) {
  return source
    // Replace if, else, each, etc statements to __derby-statement(type="if", value="expression")
    // we cheat Jade, because it has it`s own statements
    .replace(/^([ \t]+)(if|else(?:[ \t]+if)?|unless|each|with|bound|unbound|on)((?:[ \t]|\().+)?$/gm,
      function (statement, indentation, type, expression) {
        if (options.coffee) expression = ' ' + coffee(expression, true);
        return indentation + '__derby-statement(type=\"' + type + '\"' +
          (expression ? ' value=\"' + escape(expression) + '\"' : '') + ')';
    })
    // This is needed for coffee
    // find all statements in {{..}}
    .replace(/{{([^\/].*?)}}/g, function(statement, expression) {
      var block = '';
      if (blockCaptures = /^((?:unescaped|if|else if|unless|each|with|bound|unbound|on)\*?)((?:[ \t]|\().+)?$/.exec(expression)) {
        block = blockCaptures[1] + ' ';
        expression = blockCaptures[2];
      } else if (expression === 'else') {
        block = expression;
        expression = '';
      }
      if (options.coffee) expression = coffee(expression, true);
      return '{{' + block + expression + '}}';
    })
    // Make Derby attribues unescaped
    .replace(/([(, ])on-(.*?)=(['"])(.*?)\3/gm, function(statement, prefix, type, quote, expression) {
      if (options.coffee) expression = coffee(expression, true);
      return prefix + 'on-' + type + '!=\"' + expression + '\"';
    });
}

function postprocess(html) {
  return html
    // Clean redundant Derby statements
    //.replace(/[ \t]*<\/__derby-statement>\n?(?=\s+<__derby-statement type="else([ \t]+if)?")/g, '')
    .replace(r('[ \\t]*<\\/__derby-statement>' + regNewLine + '?(?=\\s+<__derby-statement type="else([ \\t]+if)?")', 'g'), '')
    // Replace Derby statements back
    .replace(/<__derby-statement type="([^"]+)"(?: value="([^"]+)")?>/gm, function (statement, type, value) {
      if (value === '%20') value = '';
      return '{{' + type + (value ? unescape(value) : '') + '}}';
    })
    // Closing Derby statements
    .replace(/<\/__derby-statement>/g, '{{/}}');
}

function compiler(file, fileName, preprocessOnly) {
  var out = [];
  var lines = file.replace(/\r\n/g, newLine).split(newLine);
  var lastComment = Infinity;
  var lastScript = Infinity;
  var lastElement = null;
  var script = [];
  var scripts = [];
  var block = [];
  var debugString;

  function renderBlock() {
    if (block.length) {
      debugString += ', block end';
      var source = preprocess(block.join(newLine));
      block = [];
      var jadeOptions = {
        filename: fileName,
        pretty: true
      }
      jade.render(source, jadeOptions, function (error, html) {
        if (error) throw error;
        html = html
          .replace(/\n/g, newLine)
          // Add colons
          //.replace(/^\s*(<([\w-:]+))((?:\b[^>]+)?>)\n?([\s\S]*?)\n?<\/\2>$/, function (template, left, name, right, content) {
          //  return left + ':' + right + (content ? newLine + content : '');
          //})
          .replace(r('\\s*(<([\\w-:]+))((?:\\b[^>]+)?>)(?:' + regNewLine + ')?([\\s\\S]*?)(?:' + regNewLine + ')?<\\/\\2>', 'g'), function (template, left, name, right, content, offset, string) {
//            console.log('-----------> HAS');
//            console.log(template);
//            console.log('-------> LEFT');
//            console.log(left);
//            console.log('-------> RIGHT');
//            console.log(right);
//            console.log('-------> CONTENT');
//            console.log(content);
            return left + ':' + right + (content ? newLine + content : '')
              + ((offset + template.length === string.length) ? '' : newLine);
          })
          // Remove underscores
          .replace(/<_derby_/g, '<')
          .replace(/<\/_derby_/g, '<\/')
          // Add scripts
          .replace(/<script(\d*)><\/script\1>/g, function(statement, index) {
            return scripts[index];
          })
          .replace(/\r$/g, '');
        out.push(postprocess(html));
      });
    }
  }

  function renderPreprocessBlock() {
    if (block.length) {
      debugString += ', block end';
      var source = preprocess(block.join(newLine));
      block = [];
      out.push(source);
    }
  }

  function closeScript() {
    if (script.length) {
      var source = script.join(newLine);
      if (options.coffee) source = coffee(source);
      script = [];
      var scriptSource = '<script>';
      source.split(newLine).forEach(function (scriptLine) {
        scriptLine = scriptLine.replace(/^\s*/g, '');
        scriptSource += newLine + addindent(scriptLine, lastScript + defaultIndent);
      });
      scriptSource += newLine + addindent('</script>', lastScript);
      scripts.push(scriptSource);
      block.push(addindent('script' + (scripts.length - 1), lastScript));
    }
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var oldLine;
    var extendMatch, extendFileName, extendFile, extendTempFileName;

    var res = /^(\s*)(.*?)$/g.exec(line);
    var spaces = res[1];
    var statement = res[2];
    var indent = spaces.length;
    debugString = addindent(statement, indent) + ' | ' + indent;

    // Comment
    if (lastComment !== Infinity) {
      if (indent > lastComment) {
        debug(debugString + ', comment');
        continue;
      } else {
        debugString += ', comment end';
        lastComment = Infinity;
      }
    }
    if (statement.indexOf('//') === 0) {
      lastComment = indent;
      debug(debugString + ', comment start');
      continue;
    }
    // Script
    if (lastScript !== Infinity) {
      if (indent > lastScript || !statement) {
        script.push(addindent(statement, indent));
        debug(debugString + ', script');
        continue;
      } else {
        debugString += ', script end';
        closeScript();
        lastScript = Infinity;
      }
    }
    if (statement.indexOf('script.') === 0) {
      // Script block
      lastScript = indent;
      debug(debugString + ', script.start');
      continue;
    }
    if (statement.indexOf('script ') === 0) {
      // Script line
      if (options.coffee) statement = 'script ' + coffee(statement.slice(7), true);
      block.push(addindent(statement, indent));
      debug(debugString + ', script line');
      continue;
    }
    // Empty line
    if (!statement.length) {
      block.push('');
      debug(debugString + ', empty');
      continue;
    }

    // Jade's "extends" and "include"
    // We have to compile the source file into a temporary one
    if ((indent === 0) && (
        extendMatch = statement.match(/^(extends|include) (\S+)/))) {
      extendFileName = path.resolve(path.dirname(fileName), extendMatch[2]);
      extendFileName = extendFileName.replace(/\.jade\s*$/, '') + '.jade';
      extendFile = fs.readFileSync(extendFileName, { encoding: 'utf8' });
      extendFile = compiler(extendFile, extendFileName, true);
      extendTempFileName = path.join( os.tmpdir(),
        crypto.createHash('md5').update(extendFileName).digest('hex')+ '.jade');
      fs.writeFileSync(extendTempFileName, extendFile);
      block.push( extendMatch[1] + ' '
        + path.relative(fileName, extendTempFileName) );
      debug(debugString + ', jade extends');
      continue;
    }

    // Other Jade reserved keywords
    // Simply pass any preprocessing of them
    if (indent === 0 &&
        /^(\+|mixin|block|prepend|append)/.test(statement)) {
      block.push(line);
      debug(debugString + ', jade reserved');
      continue;
    }

    // BEM-elements
    if (indent === 0) {
      lastElement = statement.match(/[ ,\(]bem=['"]([^'"]*)['"]/);
      lastElement = lastElement || statement.match(/[ ,\(]element=['"]([^'"]*)['"]/);
      lastElement && (lastElement = lastElement[1])
    }

    if (indent === 0) {
      // Derby tag
      // It means that we are going to start another block,
      // so we should render last one first
      if (preprocessOnly) {
        renderPreprocessBlock();
      } else {
        renderBlock();
      }
      // Remove colons after Derby tags
      // it makes colons optional
      statement = statement.replace(/:([\n\s(])/, function(statement, symbol) {
        return symbol;
      });
      statement = statement.replace(/:$/, '');
      // We add underscore to avoid problems when Derby tag name
      // is same as non closing tags
      statement = '_derby_' + statement;
      debugString += ', block start';
      block.push(statement);
    } else {
      debugString += ', block';

      // BEM replacement
      if (lastElement) {
        do {
          line = line.replace(/(^\s*[\w\.#-]*\.)(&)/, '$1' + lastElement);
          oldLine = line
        } while (line !== oldLine);
      }

      block.push(line);
    }
    debug(debugString);
  }
  // Close script if exist and render block
  closeScript();
  if (preprocessOnly) {
    renderPreprocessBlock();
  } else {
    renderBlock();
  }

  return out.join(newLine);
}
