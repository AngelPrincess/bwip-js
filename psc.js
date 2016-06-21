// file: bwip-js/psc.js
//
// The bwip-js cross-compiler.  See file psc for usage.

// PostScript lexer
function PSLEX(str) {
	var idx = 0;
	var off = 0;
	var tks = [];
	var lnr = 0;
	var stack = [];

	this.lines = {};

	// Because PostScript syntax is very relaxed, this function tokenizes
	// an entire line of text so we can keep track of where we are.
	function _next() {
		while (true) {
			while (str.charAt(off) == '\n') {
				lnr++;
				off++;
			}
			var eol = str.indexOf('\n', off);
			if (eol == -1) {
				if (off >= str.length)
					return false;
				eol = str.length;
			}
			lnr++;
			break;
		}

		var line = str.substring(off, eol);
		off = eol+1;
		tks = [];
		idx = 0;

		this.lines[lnr] = line.replace(/^\s+/,'');

		var re = /<<|>>|[ \t]+|[\r<>\[\](){}%\\"]/gm;
		var a  = re.exec(line);
		var l  = 0;
		while (a) {
			if (a.index > l)
				tks.push(line.substring(l, a.index));
			if (a[0] != '\r')
				tks.push(a[0]);

			l = re.lastIndex;
			a = re.exec(line);
		}
		if (l < line.length)
			tks.push(line.substr(l));

		return true;
	}

	// Push/pop an array of tokens onto the stream
	this.push = function(tokens) {
		stack.push(tokens);
	}
	this.pop = function() {
		stack.pop();
	}

	// We only allow peeking when there is an existing token stream i.e.
	// we are inside an executable block which is almost everywhere.
	this.peek = function() {
		if (!stack.length || !stack[stack.length-1].length) {
			return null;
		}
		var elt = stack[stack.length-1][0];
		this.token = elt.token;
		this.lnbr  = elt.lnbr;
		return elt.token;
	}
			
	// The main lexer function.  Returns the next token; null if no more
	// tokens in the current stream.
	this.next = function() {
		if (stack.length && !stack[stack.length-1].length) {
			return null;
		}
		if (stack.length) {
			var elt = stack[stack.length-1].shift();
			this.token = elt.token;
			this.lnbr  = elt.lnbr;
			return elt.token;
		}

		// remove whitespace
		while (idx < tks.length && /^[ \t]/.test(tks[idx]))
			idx++;

		while (idx >= tks.length || tks[idx] == '%') {
			if (!_next.call(this)) {
				this.token = null;
				return null;	// EOF
			}
			// remove whitespace
			while (idx < tks.length && /^[ \t]/.test(tks[idx]))
				idx++;
		}

		// Already processed token stream?
		if (tks[idx] instanceof Array) {
			this.token = tks[idx][0];
			this.lnbr  = tks[idx][1];
			idx++;
			return this.token;
		}

		// track the line number where the token begins
		this.lnbr = lnr;

		// () string
		if (tks[idx] == '(') {
			var s = '';
			var l = 1;		
			idx++;
			done: while (true) {
				while (idx < tks.length) {
					if (tks[idx] == '\\') {
						if (++idx >= tks.length && !_next.call(this))
							throw 'Unexpected end of string';
					}
					else if (tks[idx] == '"')
						tks[idx] = '\\"';
					else if (tks[idx] == '(')
						l++;
					else if (tks[idx] == ')' && --l == 0)
						break done;
					s += tks[idx++];
				}
				if (!_next.call(this)())
					throw 'Unexpected end of string';
			}

			idx++;
			this.token = '(' + s + ')';
		}

		// <> string
		else if (tks[idx] == '<') {
			var s = '';
			idx++;
			done: while (true) {
				while (idx < tks.length) {
					if (tks[idx] == '>')
						break done;
					var t = tks[idx].replace(/\s/g, '');
					if (t && !/^[a-zA-Z0-9]+$/.test(t))
						throw 'Invalid hex string: "' + t + '"';
					s += t;
					idx++;
				}
				if (!_next.call(this))
					throw 'Unexpected end of string';
			}
			if (s.length % 2)
				s += '0';

			var t = '';
			for (var i = 0; i < s.length; i += 2)
				t += '\\x' + s.substr(i, 2);

			idx++;
			this.token = '(' + t + ')';
		}
		else
			this.token = tks[idx++];

		return this.token;
	}
}


// PostScript Cross-Compiler
function PSC(str, flags) {
	var lex = new PSLEX(str);

	// Configure from command line flags
	var cfg = {
		devar:		true,	// run devar() optimization
		coverage:	false,	// no branch coverage instrumentation
	};

	for (var i = 0; i < flags.length; i++) {
		switch (flags[i]) {
		case '--no-devar':		cfg.devar = false;		break;
		case '--with-devar':	cfg.devar = true;		break;
		case '--no-coverage':	cfg.coverage = false;	break;
		case '--with-coverage':	cfg.coverage = true;	break;
		default:
			if (flags[i]) {
				console.log('Unknown flag "' + flags[i] + '" ignored.');
			}
		}
	}

	// Curly-braces embedded in strings cause vim to mis-match
	const LC = '\x7b';
	const RC = '\x7d';

	// Home for all of the postscript operators
	var $ = {};

	// Knowledge of user-defined symbols
	var dict = {};
	var dlvl = 0;

	// Execution context stack
	var context = [];

	// Compilation trace stack
	var st = [];
	var sp = 0;

	// Temporary variable number seed
	var tvarno = 0;

	// Branch coverage seed
	var branchno = -1;		// -1 == disabled

	// Current code block
	var block = [];
	var depth = 0;
	var seq   = 0;

	// We do a two-pass compilation of each global function.  The first pass
	// is used to find all user-defined identifiers (allowunknown=true).
	// The second pass emits the code (allowunknown=false).
	var allowunknown = false;

	// The unknown-type must be zero i.e. falsy.
	const TYPE_UNKNOWN	= 0x0000;

	// N.B.: The VAL types are <<1 difference from their corresponding LIT
	//		 types.
	const TYPE_INTLIT	= 0x0001;
	const TYPE_INTVAL	= 0x0002;
	const TYPE_INTTYP	= 0x0003;
	const TYPE_NUMLIT	= 0x0004;
	const TYPE_NUMVAL	= 0x0008;
	const TYPE_NUMTYP	= 0x000f;
	const TYPE_STRLIT	= 0x0010;
	const TYPE_STRVAL	= 0x0020;
	const TYPE_STRTYP	= 0x0030;
	const TYPE_ARRAY	= 0x0040;
	const TYPE_DICT		= 0x0080;
	const TYPE_NULL		= 0x0100;
	const TYPE_BOOLEAN	= 0x0200;
	const TYPE_IDENT	= 0x0400;		// /ident
	const TYPE_IENAME	= 0x0800;		// //ident (immediately evaluated name)
	const TYPE_TOKENS	= 0x1000;
	const TYPE_FUNCTION	= 0x2000;
	const TYPE_PRECALC	= 0x4000;		// A precalculated value (code hoisting)

	function clone(x) {
		return {
			type:x.type,
			expr:x.expr,
			seq: ++seq,
		};
	}

	// Track depth of the stack references
	function need(n) {
		for (var tmp = n - sp; tmp > 0; tmp--) {
			var tid = tvar();
			block.push({ code:'var ' + tid + '=$k[--$j];', lnbr:lex.lnbr,
						 seq:++seq });
			st.unshift({ type:TYPE_UNKNOWN, expr:tid, seq:++seq });
			sp++;
			depth++;
		}
	}

	// For debugging of the trace stack.
	function dump(id) {
		console.log('[[[' + id + '#' + lex.lnbr);
		for (var i = sp-1; i >= 0; i--) {
			console.log(i, st[i]);
		}
		console.log(']]]');
	}

	// Decide if the expression needs parentheses
	function parens(x) {
		if (/^[A-Za-z_$][\w_$.]*$/.test(x) ||	// 'dot' expression
			/^-?[0-9.]+$/.test(x) ||			// number literal
			/^"([^"\\]|\\.)*"$/.test(x) ||		// string literal
			/^[\w_$.]+\([^;()]*\)$/.test(x)) {	// function call
			return x;
		}
		return '(' + x + ')';
	}

	// Emit a line of code.  May be multiple lines e.g. a function.
	function emit(code, lnbr) {
		if (typeof code == 'object') {
			lnbr = code.lnbr;
			code = code.code;
		}
		block.push({ code:code, lnbr:lnbr||lex.lnbr, seq:++seq });
	}

	// lines is the return value from ctxpop()
	function append(lines) {
		for (var i = 0; i < lines.length; i++) {
			block.push({ code:lines[i].code, lnbr:lines[i].lnbr, seq:++seq });
		}
	}
	
	// Perform some simple code elimination.  need() generates code that is
	// often of the form:
	//		var X = $k[--$j];		// need()
	//		blah X blah;
	//
	// And dictionary expressions are emitted as:
	//		var X = $1.value;
	//		var Y = $1.index;
	//		var Z = $get($X, $Y);
	//
	// We look or the 'var X' declaration followed by a single usage of X,
	// and when found, elminate the declaration, substituting the expression
	// directly.  This strategy reduces LOC by about a third.  Future
	// work can get even more aggressive.
	// 
	// With the need() case, we must watch for references to the stack $k
	// or the stack pointer $j.  If one is seen between the var declaration
	// and usage, we abort the optimization.
	//
	// Likewise, with dictionary expressions, we must watch for re-assignment
	// of the expression between the var declaration and usage.  Here is some
	// sample code from the qrcode encoder:
	//		var _X = $1.thispairs;
	//		$1.thispairs = $1.lastpairs;
	//		$1.lastpairs = _X;
	//
	// The code swaps the values of thispairs and lastpairs and will be
	// rendered invalid if we eliminate the var _SP declaration and
	// substitute directly.
	//
	// But it is ok for the assignment to occur on the same line as the
	// variable reference.  This pattern occurs all over:
	//		var _X = $1.textfont;
	//		$1.textfont = "" + _X;
	//
	// That is safe to substitute as it is self-referencing.

	// 'lines' is from ctxpop().
	function devar(lines) {
		// There are hidden stack references:
		//		$a()
		//		$d()
		// 
		// Note that $aload()/$astore()/$etc are safe as they
		// ctxflush() and we are guaranteed that no var-refs
		// exist afterwards.  $a() and $d() are special because 
		// they do not do a post-ctxflush() and variable state can
		// trickle down past their calls.
		var restack = /(\$j)|(\$k)|(\$[ad]\(\))/;

		// We only substitute var-decls that are terms (no operator precedence
		// issues). E.g.:
		//		var _X = $k[--$j];
		//		var _X = $0.textmap[blah];
		//		var _X = $1.func(blah,blah).Ident;
		var redecl = /^var (_[\w$_]+)=([\w_$.]+(\(.*\))?(\[.+\])?(\.[\w_$]+)*);(\/\*[^;]*\*\/)?$/;

		for (var i = 0; i < lines.length; i++) {
			var decl = redecl.exec(lines[i].code);

			// Do not re-order graphics context calls, sequence is significant.
			if (decl && !/^\$\$\./.test(decl[2])) {
				var where  = 0;			// line where variable is referenced
				var assign = 0;			// line the expression is assigned to
				var jkref  = Infinity;	// line with first stack reference
				for (var j = i+1; j < lines.length; j++) {
					// De-string the line so our pattern matching doesn't see
					// potential false positives.
					var line = lines[j].code.replace(/"([^\\"]|\\.)*"/g, '')
											.replace(/'([^\\']|\\.)*'/g, '');
					// Track of where the first stack reference occurs.
					if (jkref === Infinity && restack.test(line)) {
						jkref = j;
					}
					// Look for any var-ident references
					var fst = line.indexOf(decl[1]);
					var lst = line.lastIndexOf(decl[1]);
					if (fst != -1) {
						if (where || lst != fst) {
							where = -1;
							break;
						}
						where = j;
					}
					// Is the decl-expression being assigned?
					if (line.indexOf(decl[2] + '=') == 0) {
						if (assign) {
							where = -1;
							break;
						}
						assign = where;
						break;
					}
					// Stop searching at the end of a block.  Array and
					// dictionary on-stack building carry var refs into loops.
					if (/^\}/.test(line)) {
						break;
					}
				}
				
				// Decide whether to eliminate the var declaration.
				if (where > 0) {
					// If the var decl references the stack, there can be
					// no other stack references.
					if (restack.test(decl[2]) && jkref <= where) {
						continue;
					}
					// No assignment above the target line
					if (assign && assign < where) {
						continue;
					}

					// Safe to make the substitution.  $ is meaninful to
					// replace(), so double them up.
					lines[where].code = lines[where].code
							.replace(decl[1], decl[2].replace(/\$/g, '$&$&'));
					lines.splice(i--, 1);
				}
			}
		}
	}
	
	// Flushes all trace state to the postscript stack.  Trace stack is
	// empty afterwards.  The more ctxflush()s we do, the safer but less
	// optimized the emitted code.
	function ctxflush() {
		for (var i = 0; i < sp; i++) {
			if (st[i].expr === undefined) {
				dump('ctxflush');
				throw 'ctxflush: missing expression';
			} else {
				block.push({ code:'$k[$j++]=' + st[i].expr + ';',
							 lnbr:lex.lnbr, seq:++seq });
			}
		}
		sp = 0;
	}

	// Prepare to emit an executable object (usually an executable block of
	// tokens, but not always).
	function ctxprep(exec) {
		if (exec.type == TYPE_IENAME) {
			// do-nothing
		} else if (exec.type == TYPE_PRECALC) {
			// do-nothing
		} else if (exec.type == TYPE_TOKENS) {
			ctxpush(exec.tokens);
		} else {
			dump('ctxprep');
			throw 'ctxprep: unknown exec-type';
		}
	}
	// Emit the executable object.
	function ctxexec(exec) {
		if (exec.type == TYPE_IENAME) {
			return [{ code:exec.expr + '();', lnbr:lex.lnbr, seq:++seq }]
		} else if (exec.type == TYPE_PRECALC) {
			return [{ code:exec.expr, lnbr:lex.lnbr, seq:++seq }];
		} else if (exec.type == TYPE_TOKENS) {
			compile();
			return ctxpop();
		}
	}

	function ctxpush(tokens) {
		// Do not ctxflush() here - the array and dictionary literal code
		// does not want it.

		context.push({ st:st, sp:sp, block:block, depth:depth });
		lex.push(tokens);

		st		= [];
		sp		= 0;
		block	= [];
		depth	= 0;
		seq		+= 100;		// Make the gaps noticable
	}

	function ctxpop() {
		ctxflush();

		//block.sort(function(a,b) { return a.seq - b.seq });

		lex.pop();
		var ctx = context.pop();
		var tmp = block;

		st		= ctx.st;
		sp		= ctx.sp; 
		depth	= ctx.depth;
		block	= ctx.block;

		return tmp;
	}

	// Variable-name compatible base-62 character set
	_b62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

	// Return the next temp-var
	function tvar() {
		return '_' + b62(tvarno++);

		function b62(n) {
			var v = '';
			while (n >= 62) {
				v = _b62[n % 62] + v;
				n = (n / 62)|0;
			}
			return _b62[n] + v;
		}
	}

	// Emits a code coverage branch tracker
	function newbranch() {
		if (branchno > -1) {
			emit('$bwipjs_coverage[' + (branchno++) + ']=1;');
		}
	}

	// Binary arithmetic operator
	function binarith(op) {
		need(2);
		var t1 = st[sp-1].type;
		var t2 = st[sp-2].type;

		// Don't constant fold.  Especially with division, smaller code
		// results when not folded.  Besides, every JS compiler out there
		// constant folds on the first pass anyway.
		//if ((t1&(TYPE_INTLIT|TYPE_NUMLIT))&&(t2&(TYPE_INTLIT|TYPE_NUMLIT))) {
		//	st[sp-2].type = ((t1|t2) & TYPE_NUMLIT) ? TYPE_NUMLIT : TYPE_INTLIT;
		//	st[sp-2].expr = '' +
		//				eval(st[sp-2].expr + ' ' + op + ' ' + st[sp-1].expr);
		//} else {
			if ((t1 & TYPE_INTTYP) && (t2 & TYPE_INTTYP) && op != '/') {
				st[sp-2].type = TYPE_INTVAL;
			} else {
				st[sp-2].type = TYPE_NUMVAL;
			}
			st[sp-2].expr = parens(st[sp-2].expr) + op +
							parens(st[sp-1].expr);
		//}
		st[sp-2].seq = ++seq;
		sp--;
	}

	// Arithmetic or logical binary operator returning boolean
	// ariop is the arithmetic operator such as <=, &, etc. and works on
	//  numbers and booleans.  (Admittedly, the `<` operator doesn't work
	//  on booleans but that should not occur in practice).
	// funop is the name of  the function to call to get the same operator
	//  semantics on more complex types, primarily strings or unknowns
	//  e.g. $ne()
	//
	// FUTURE:	We need to track the difference between a js-string and a
	// 			uint8-string.  There are lots of places where we can use
	//			==/!= rather than $eq/$ne when both sides of the expression
	//			are js-strings.
	function binbool(ariop, funop) {
		need(2);

		var t1 = st[sp-1].type;
		var t2 = st[sp-2].type;

		// Arithmetic 
		if ((t1&TYPE_NUMTYP) || (t2&TYPE_NUMTYP) || (t1&TYPE_BOOLEAN) ||
				(t2&TYPE_BOOLEAN)) {
			st[sp-2].expr = parens(st[sp-2].expr) + ariop +
							parens(st[sp-1].expr);
			st[sp-2].type = TYPE_BOOLEAN;
		} else {
			// e.g $ne(expr1, expr2)
			st[sp-2].expr = funop + '(' + st[sp-2].expr + ',' +
							st[sp-1].expr + ')';
			st[sp-2].type = TYPE_BOOLEAN;
		}
		st[sp-2].seq = ++seq;
		sp--;
	}

	// Read to the end of the inline dictionary definition, inline array
	// definition, or executable code block.
	// end == '>>' or '}' or ']' or ...
	function readtokens(end) {
		var count  = 0;
		var tokens = [];
		while (lex.next() !== null) {
			if (lex.token == '{' || lex.token == '<<' || lex.token == '[') {
				count++;
			} else if (lex.token=='}' || lex.token=='>>' || lex.token==']') {
				count--;
			}
			if (lex.token == end && count < 0) {
				return tokens;
			}
			tokens.push({ token:lex.token, lnbr:lex.lnbr });
		}
	}

	// The main compilation loop.
	// MRW:  This code needs refactoring!
	function compile() {
		while (lex.next() !== null) {
			var tkn  = lex.token;
			var lnbr = lex.lnbr;

			// Starting an exec block - wait until we determine how it is
			// being used before compiling it.
			if (tkn == '{') {
				var tokens = readtokens('}');

				st[sp++] = { type:TYPE_TOKENS, tokens:tokens, seq:++seq };
			} else if (tkn == '[') {
				// emit the code to build the array at runtime
				ctxpush(readtokens(']'));
				compile();
				var lines = ctxpop();

				// Check if the array is static.  A static array contains only
				// code with lines:
				//		$k[$j++]=<blah>
				//			or
				//		var <var>=<blah>
				//
				// Where var <var>=<blah> cannot pull from the stack (inside a 
				// forall loop e.g.)
				for (var i = 0; i < lines.length; i++) {
					if (/^var [^=]+=.*\$k\[--\$j\]/.test(lines[i].code)) {
						break;
					}
					if (!/^\$k\[\$j\+\+\]=/.test(lines[i].code) &&
						!/^var [^=]+=/.test(lines[i].code)) {
						break;
					}
				}

				var tid = tvar();

				// Static array?
				if (i == lines.length) {
					var code = '';
					for (var i = 0; i < lines.length; i++) {
						// Hoist var declarations
						if (lines[i].code.indexOf('var ') == 0) {
							emit(lines[i]);
						} else {
							var a = /^\$k\[\$j\+\+\]=([\s\S]+);(\/\*[^;]*\*\/)?$/.exec(lines[i].code);
							code += (code.length ? ',' : '') + a[1];
						}
					}
					emit('var ' + tid + '=$a([' + code + ']);');
					st[sp++] = { type:TYPE_ARRAY, expr:tid, seq:++seq };
				} else {
					// Does the top of the stack contain an ident?  And is the
					// next token a def?
					// If so, we can inline the array creation with the dict
					// assignment.
					var defsym = '';
					if (sp && st[sp-1].type == TYPE_IDENT &&
							lex.peek() == 'def') {
						defsym = st[--sp].expr;
					}

					// Build the array at runtime
					ctxflush();
					emit('$k[$j++]=Infinity;');
					for (var i = 0; i < lines.length; i++) {
						emit(lines[i]);
					}

					if (defsym) {
						if (/^"\w+"$/.test(defsym)) {
							emit('$' + dlvl + '.' +
								defsym.substr(1, defsym.length-2) + '=$a();');
						} else {
							emit('$' + dlvl + '[' + defsym + ']=$a();');
						}
						lex.next();	// consume the def
						dict[defsym.substr(1,defsym.length-2)] = TYPE_ARRAY;
					} else {
						emit('var ' + tid + '=$a();');
						st[sp++] = { type:TYPE_ARRAY, expr:tid, seq:++seq };
					}
				}
			}
			else if (tkn == '<<') {
				// emit the code to build the object at runtime
				ctxpush(readtokens('>>'));
				compile();
				var lines = ctxpop();

				// Check if the object is static.  A static object contains
				// sets of lines as:
				//	var <var>=<blah>;	(optional)
				//	$k[$j++]="string";
				//	var <var>=<blah>;	(optional)
				//	$k[$j++]=<blah>;
				//
				// No semi-colons allowed in <blah> except when it is a
				// function definition e.g.
				//		$k[$j++]=function() {
				//			<code here with semicolons>
				//		}
				for (var i = 0; i < lines.length; i++) {
					// Optional var declarations
					while (/^var [^=]+=/.test(lines[i].code)) {
						i++;
					}
					// Must be a string
					if (!/^\$k\[\$j\+\+\]=['"].*['"];/.test(lines[i].code)) {
						break;
					}
					i++
					// More optional var declarations
					while (/^var [^=]+=/.test(lines[i].code)) {
						i++;
					}
					// Must be a stack push
					if (!/^\$k\[\$j\+\+\]=/.test(lines[i].code)) {
						break;
					}
				}

				var tid = tvar();

				// Static?
				if (i == lines.length) {
					var code = LC + '\n';
					for (var i = 0; i < lines.length; i++) {
						code += i ? ',' : '';

						// Hoist optional var declarations
						while (lines[i].code.indexOf('var ') == 0) {
							emit(lines[i]);
							i++;
						}

						// Extract the property name
						var n = /^\$k\[\$j\+\+\]=['"](.*)['"];/
													.exec(lines[i].code);
						i++;

						// Hoist optional var declarations
						while (lines[i].code.indexOf('var ') == 0) {
							emit(lines[i]);
							i++;
						}

						// Extract the value expression
						var a = /^\$k\[\$j\+\+\]=([\s\S]+);(\/\*[^;]*\*\/)?$/
														.exec(lines[i].code);

						// Is the ident a js-id?
						if (/^[A-Za-z_]\w*$/.test(n[1])) {
							code += n[1] + ':' + a[1];
						} else {
							code += '"' + n[1] + '":' + a[1];
						}
					}
					emit('var ' + tid + '=' + code + '\n' + RC + ';');
					st[sp++] = { type:TYPE_DICT, expr:tid, seq:++seq };
				} else {
					// Build the object at runtime
					ctxflush();
					emit('$k[$j++]=Infinity;');
					for (var i = 0; i < lines.length; i++) {
						emit(lines[i]);
					}
					emit('var ' + tid + '=$d();');
					st[sp++] = { type:TYPE_DICT, expr:tid, seq:++seq };
				}
			}
			else if (/^[-0-9.]/.test(tkn)) {
				// watch for radix numbers:
				//	n#????
				//	nn#????
				if (tkn.charAt(1) == '#')
					var val = parseInt(tkn.substr(2), parseFloat(tkn));
				else if (tkn.charAt(2) == '#')
					var val = parseInt(tkn.substr(3), parseFloat(tkn));
				else
					var val = parseFloat(tkn);

				if (val % 1) {
					st[sp++] = { type:TYPE_NUMLIT, expr:'' +val, seq:++seq };
				} else {
					st[sp++] = { type:TYPE_INTLIT, expr:'' +val, seq:++seq };
				}
			} else if (tkn[0] == '(') {
				st[sp++] = { type:TYPE_STRLIT,
							 expr:'"' + tkn.substr(1, tkn.length-2) + '"',
							 seq:++seq
						};
			} else if (tkn[0] == '/') {
				// Watch for immediately evaluated names (IEN).  With BWIPP,
				// these are always globally defined (on the $0 dict).
				if (tkn[1] == '/') {
					// Simple ident or needs quotes?
					if (/\/\/[A-Za-z_]\w*$/.test(tkn)) {
						st[sp++] = { type:TYPE_IENAME, expr:'$0.'+tkn.substr(2),
									 seq:++seq };
					} else {
						st[sp++] = { type:TYPE_IENAME,
									 expr:'$0["' + tkn.substr(2) + '"]',
									 seq:++seq };
					}
					dict[tkn.substr(2)] = TYPE_IENAME;
				} else {
					var id = tkn.substr(1);
					//var ty = dict[id] || TYPE_IDENT;
					st[sp++] = { type:TYPE_IDENT, expr:'"' + id + '"',
								 seq:++seq };
					if (!dict[id]) {
						dict[id] = TYPE_IDENT;
					}
				}
			} else if ($[tkn]) {
				//dump(tkn);
				$[tkn]();
			} else if (dict[tkn] !== undefined || allowunknown ) {
				if (dict[tkn] == TYPE_FUNCTION) {
					// Push state to stack before calling
					ctxflush();
					if (/^[A-Za-z_]\w*$/.test(tkn)) {
						emit('$' + dlvl + '.' + tkn + '();');
					} else {
						emit('$' + dlvl + '["' + tkn.replace(/[\\"]/g,'\\$&') +
							 '"]();');
					}
				// We cannot directly use a dictionary reference as a
				// trace expression.  Intermediate variables must be used to
				// emulate the run-time stack.  Consider the following bit
				// of code:
				//		/lastpairs thispairs /thispairs lastpairs def def
				// (see qrcode).
				//
				// That takes the current value of thispairs and places it on
				// the stack.  It then assigns the current value of lastpairs
				// to thispairs; then assigns the previous value of thispairs
				// to lastpairs. PostScript swap idiom.  And a temp-variable
				// must exist to hold that initial reference to thispairs.
				//
				// This de-optimization caused massive unnecessary var
				// assignments.  See devar() for recovery from it.
				//
				// Do not change this code.  Took hours of debugging to find
				// this issue.  Optimize using peephole techniques instead.
				} else if (/^[$A-Za-z_]\w*$/.test(tkn)) {
					var tid = tvar();
					emit('var ' + tid + '=$' + dlvl + '.' + tkn + ';');
					st[sp++] = { type:dict[tkn] || TYPE_UNKNOWN,
								 expr:tid, seq:++seq
							};
				} else {
					var tid = tvar();
					emit('var ' + tid + '=$' + dlvl + '["' +
								 	  tkn.replace(/[\\"]/g,'\\$&') + '"];');
					st[sp++] = { type:dict[tkn] || TYPE_UNKNOWN,
								 expr:tid, seq:++seq
							};
				}
			} else {
				// If you get here, most likely Terry used a new postscript
				// operator that we haven't seen before.
				console.log('UNKNOWN IDENT: (' + tkn + ') #' + lnbr);
				dump(tkn);
				throw 'UNKNOWN IDENT: (' + tkn + ') #' + lnbr;
			}
		}
	}

	//
	// The postscript operators.  To understand these, you need a copy of
	// the language reference manual (google postscript red book). 
	//

	// PSC compile-time debugging.  Insert debug into the postscript text
	// to trigger this.
	$.debug = function() {
		dump('debug');
		debugger;
	}

	// Run-time debugging
	$.stack = function() {
		emit('$stack();');
	}

	// Postscript does not have a return-out-of-exec-block operator but
	// we need one to return immediately from our custom renderers when
	// running the test framework (leaving the rendering information on
	// the stack for inspection).
	$.return = function() {
		emit('return;');
	}

	// Push the current dictionary.  We use this operator to create the
	// function-scoped $1 dictionary.
	$.begin = function() {
		need(1);
		emit('var $' + (++dlvl) + '={};');
		sp--;
	}

	// Pop the current dictionary
	$.end = function() {
		// Not necessary - its always at the end of a function definition
		//emit('$' + (dlvl--) + '=null;');
		dlvl--;
	}

	// Create an dictionary on the stack.  Used both for the dictionary
	// stack (a no-op) and for runtime created objects.
	$.dict = function() {
		// Ignore the size parameter.
		st[sp-1] = { type:TYPE_DICT, expr:'{}', seq:++seq };
	}

	$.known = function() {
		$.get();		// Use get logic
		var parse = /^(var (_[\w_$]+)=[\s\S]+);(\/\*[^;]*\*\/)?$/
							.exec(block[block.length-1].code);
		if (!parse) {
			console.log(block[block.length-1].code);
			throw 'known: could not parse $.get output';
		}

		// And then append !==undefined
		block[block.length-1].code = parse[1] + '!==undefined;' +
									(parse[3] || '');
		st[sp-1] = { type:TYPE_BOOLEAN, expr:parse[2], seq:++seq };
	}

	// $0.$error is defined in bwipp-hdr.js.
	$.handleerror = function() {
		emit('throw new Error($0.$error.errorname+": "+$0.$error.errorinfo);');
	}
	$.quit = function() {
		// no-op : handlerror throws
	}

	// OBSOLETE:  setanycolor in the renderers has been replaced by custom
	//			  logic.  No eval of strings required now.
	// BWIPP only requires support for two forms of runtime eval. Hex string
	// literals in the form <rrggbb> and <ccmmyykk>.  Implemented in $eval().
	$.exec = function() {
		need(1);
		var type = st[sp-1].type;
		var expr = st[--sp].expr;
		if (type == TYPE_IENAME) {
			ctxflush();
			emit(expr + '();');
		} else if (type & TYPE_STRTYP) {
			throw new Error('eval of string-type not supported');
			//var tid = tvar();
			//emit('var ' + tid + '=$eval(' + expr + ');');       // EM-BED
			//st[sp++] = { type:TYPE_STRVAL, expr:tid, seq:++seq };
		} else {
			// Most likely a function call.  If we guess wrong, we will
			// get a runtime error...
			ctxflush();
			emit(parens(expr) + '();');
		}
	}

	$.exch = function() {
		need(2);
		var t = st[sp-1];
		st[sp-1] = st[sp-2];
		st[sp-2] = t;
		st[sp-2].seq = ++seq;
		st[sp-1].seq = ++seq;
	}
	$.dup = function() {
		need(1);
		// Duplicate as-is literals and simple expressions (temp variables).
		// More complex expressions are assigned a temp variable that 
		// replaces both source and dest expressions.
		if (st[sp-1].type & (TYPE_INTLIT|TYPE_NUMLIT|TYPE_STRLIT)) {
			//st[sp] = clone(st[sp-1]);
		} else if (/^_[\w$_]+$/.test(st[sp-1].expr)) {
			//st[sp] = clone(st[sp-1]);
		} else {
			// Convert the expression to a temp-var.
			var tid = tvar();
			emit('var ' + tid + '=' + st[sp-1].expr + ';');
			st[sp-1].expr = tid;
		}
		st[sp] = clone(st[sp-1]);
		sp++;
	}
	$.copy = function() {
		var arg = st[sp-1];
		if (arg.type & TYPE_INTLIT) {	// Value known at compile time
			sp--;
			var num = +arg.expr;
			need(num);
			var idx = sp - num;
			while (num-- > 0) {
				st[sp++] = clone(st[idx++]);
			}
		} else if (arg.type & TYPE_STRVAL) { 
			need(2);
			var src = st[sp-2].expr;
			var dst = st[sp-1].expr;
			var tid = tvar();
			// Use the internal strcpy operator
			emit('var ' + tid + '=$strcpy(' + dst + ',' + src + ');'); // EMBED
			st[sp-2] = { type:TYPE_STRVAL, expr:tid, seq:++seq };
			sp--;
		} else {
			// Terry used copy in some new way...
			console.log(arg);
			throw 'TBD';
		}
	}
	$.roll = function() {
		var d = st[--sp];	// direction and iters
		var n = st[--sp];	// how many elts roll
		if (d.type != TYPE_INTLIT || n.type != TYPE_INTLIT) {
			throw new Error('roll: parameters not constant.');
		}
		d = +d.expr;
		n = +n.expr;
		need(n)
		if (d < 0) {
			var t = st.splice(sp-n, -d);
		} else {
			var t = st.splice(sp-n, n-d);
		}
		st.splice.apply(st, [sp-t.length, 0].concat(t));
		for (var i = sp-n; i < sp-1; i++) {
			st[i].seq = ++seq;
		}
	}
	// BWIPP uses index two ways:
	//	<const> index
	//	counttomark <const> add index
	// FUTURE:	We should be able to optimize the counttomark case since
	// 			we can "see" what was pushed onto the stack X before the
	//			mark.  Eliminating the counttomark would be a significant
	//			runtime win.
	//			The only potential gotcha is if the code moves the mark on
	//			the stack, but all uses appear to leave the mark in situ.
	$.index = function() {
		need(1);
		var v = st[--sp];
		if (v.type == TYPE_INTLIT) {
			var index = +v.expr + 1;	// index is zero offset
			need(index);
			st[sp] = clone(st[sp - index]);
			sp++;
		} else {
			var tid = tvar();
			ctxflush();
			emit('var ' + tid + '=$k[$j-1-' + parens(v.expr) + '];');
			st[sp++] = { type:TYPE_UNKNOWN, expr:tid, seq:++seq };
		}
	}

	// Convert to integer
	$.cvi = function() {
		need(1);
		if (st[sp-1].type & TYPE_NUMTYP) {
			// Round towards zero
			st[sp-1] = { type:TYPE_INTVAL, expr:'~~' + parens(st[sp-1].expr),
						 seq:++seq };
		} else {
			st[sp-1] = { type:TYPE_INTVAL, expr:'~~$z(' + st[sp-1].expr + ')',
						 seq:++seq };
		}
	}

	// Convert to string 
	$.cvlit = function() {
		need(1);
		if (/^[\w_$.\[\]]+$/.test(st[sp-1].expr)) {
			st[sp-1] = { type:TYPE_STRVAL, expr:'""+' + st[sp-1].expr,
						 seq:++seq };
		} else {
			st[sp-1] = { type:TYPE_STRVAL, expr:'""+' + parens(st[sp-1].expr),
						 seq:++seq };
		}
	}

	// Convert to name (no-op)
	$.cvn = function() {
	}

	// Convert to string
	//		any string cvs string-view
	$.cvs = function() {
		need(2);
		var str = st[--sp].expr;
		var any = st[--sp].expr;
		emit('$cvs(' + str + ',' + any + ');');		// EMBED
	}

	// Convert to executable (no-op)
	$.cvx = function() {
	}

	// Convert to real
	$.cvr = function() {
		need(1);
		var expr = st[sp-1].expr;
		st[sp-1] = { type:TYPE_NUMVAL, expr:'+' + parens(expr), seq:++seq };
	}

	// Convert with radix to string
	$.cvrs = function() {
		need(3);
		var val = st[sp-3].expr;
		var rdx = st[sp-2].expr;	// radix
		var dst = st[sp-1].expr;
		var tid = tvar();
		emit('var ' + tid +
					'=$cvrs(' + dst + ',' + val + ',' + rdx + ');'); // EMBED
		st[sp-3] = { type:TYPE_STRVAL, expr:tid, seq:++seq };
		sp-=2;
	}

	$.type = function() {
		need(1);
		var tid = tvar();
		emit('var ' + tid + '=$type(' + st[--sp].expr + ');');		// EMBED
		st[sp++] = { type:TYPE_STRVAL, expr:tid, seq:++seq };
	}

	$.true = function() {
		st[sp++] = { type:TYPE_BOOLEAN, expr:'true', seq:++seq };
	}
	$.false = function() {
		st[sp++] = { type:TYPE_BOOLEAN, expr:'false', seq:++seq };
	}
	$.null = function() {
		st[sp++] = { type:TYPE_NULL, expr:'null', seq:++seq };
	}

	$.pop = function() {
		if (sp > 0) {
			sp--;
		} else if (block.length) {
			// We often emit consecutive $j--.  Merge them.
			if (block[block.length-1].code == '$j--;') {
				block[block.length-1].code = '$j-=2;';
			} else if (/^\$j-=\d+;/.test(block[block.length-1].code)) {
				var inc = +(/\d+/.exec(block[block.length-1].code)[0]) + 1;
				block[block.length-1].code = '$j-=' + inc + ';';
			} else {
				emit('$j--;');
			}
		} else {
			emit('$j--;');
		}
	}

	$.length = function() {
		need(1);
		st[sp-1].expr += '.length';
		st[sp-1].type  = TYPE_INTVAL;
		st[sp-1].seq   = ++seq;
	}

	$.bind = function() {
		var tkns = st[--sp].tokens;
		if (!tkns) {
			dump('bind');
			throw 'bind: exec not tokens';
		}

		// If we are defining a global function, reset our global state.
		if (dlvl == 0) {
			// First pass to define all identifers (in dict)
			allowunknown = true;
			tvarno		 = 0;
			seq			 = 0;
			dict		 = {};
			branchno	 = -1;	// Disable for the first pass

			// BWIPP unknowns
			dict.$error = TYPE_DICT;
			dict.opt	= TYPE_DICT;
			dict.pixx	= TYPE_INTVAL;
			dict.pixy	= TYPE_INTVAL;
			dict.pixs	= TYPE_ARRAY;

			// bwipjs special symbols
			dict.bwipjs_dontdraw = TYPE_BOOLEAN;

			ctxpush(tkns.slice(0));		// clone the tokens array
			compile();
			ctxpop();

			allowunknown = false;		// second pass, disallow unknowns
			tvarno		 = 0;
			seq			 = 0;

			if (cfg.coverage) {
				branchno = 0;			// enable for the 2nd pass
			}
		}

		// Capture the current branch-number so they stay consecutive down
		// the flow of code.
		var thisbranchno = dlvl && cfg.coverage ? branchno++ : 0;

		ctxpush(tkns);
		compile();
		var lines = ctxpop();

		// Perform simple var declaration elimination.
		if (cfg.devar) {
			devar(lines);
		}

		// The top of the trace stack contains the name of this function
		var fname = sp && st[sp-1].type == TYPE_IDENT ? st[sp-1].expr : '';

		if (dlvl == 0 && cfg.coverage && fname) {
			emit('$bwipjs_functions.push(' + fname + ');');
		}
		var code = 'function()' + LC + '\n';

		if (dlvl == 0 && cfg.coverage && fname) {
			// We always emit the maximum value so we know how many
			// And place the entire function in a try-catch block so
			// we can save our coverage even when an error throws.
			code += 'var $bwipjs_coverage={' + branchno + ':1};\n' +
					'try {\n';
		} else if (dlvl && cfg.coverage) {
			code += '$bwipjs_coverage[' + (thisbranchno) + ']=1;\n';
		}
		for (var i = 0; i < lines.length; i++) {
			code += lines[i].code + '/*' + lines[i].lnbr + '*/\n';
		}
		if (dlvl == 0 && cfg.coverage && fname) {
			code += '}catch(e){\n' +
					'throw e;\n' +
					'}finally{\n' +
					'typeof require==="function"&&' +
					'require("fs").appendFileSync("coverage/' +
					fname.substr(1, fname.length-2) + '",' +
					'Object.keys($bwipjs_coverage).join("\\n")+"\\n",' +
					'"binary");\n' +
					'}\n';
			// Disable outside of global functions.
			branchno = -1;
		}
		code += RC;
		st[sp++] = { type:TYPE_FUNCTION, expr:code, seq:++seq };
	}

	$.def = function() {
		need(2);

		// Watch for executable blocks of tokens and auto-convert to function
		if (st[sp-1].type == TYPE_TOKENS) {
			$.bind();
		}

		var id = st[sp-2].expr;
		var ty = st[sp-1].type;

		// Convert literals to their value counter-parts
		if (ty & (TYPE_STRLIT|TYPE_INTLIT|TYPE_NUMLIT)) {
			ty <<= 1;
		}

		// And convert string value idents that are actually literals
		if (/^"([^\\"]|\\.)*"$/.test(id)) {
			st[sp-2].type = TYPE_STRLIT;
		}

		// If the previous line is `var X=<value>` and the current expression
		// is X, then merge the two lines.
		//if (block.length && /^var _/.test(block[block.length-1].code)) {
		//	var assign = /^var (_[\w_$]+)=([\s\S]+);(\/\*[^;]*\*\/)?$/
		//						.exec(block[block.length-1].code);
		//	if (assign && assign[1] == st[sp-1].expr) {
		//		block.pop();
		//		st[sp-1].expr = assign[2];
		//	}
		//}

		if (st[sp-2].type == TYPE_STRLIT || st[sp-2].type == TYPE_IDENT) {
			if (/^"[A-Za-z_]\w*"$/.test(id)) {
				emit('$' + dlvl + '.' + id.substr(1, id.length-2) + '=' +
							st[sp-1].expr + ';');
			} else {
				emit('$' + dlvl + '[' + id  + ']=' + st[sp-1].expr + ';');
			}
			dict[id.substr(1, id.length-2).replace(/\\(.)/g, '$1')] = ty;
		} else {
			emit('$' + dlvl + '[' + id + ']=' + st[sp-1].expr + ';');
		}
		sp-=2;
	}

	// load looks up key the same way the interpreter looks up executable
	// names that it encounters during execution. However, load always pushes
	// the associated value on the operand stack; it never executes the value. 
	$.load = function() {
		need(1);
		var tid = tvar();
		emit('var ' + tid + '=$1[' + st[sp-1].expr + '];');
		st[sp-1] = { type:TYPE_UNKNOWN, expr:tid, seq:++seq };
	}

	$.get = function() {
		need(2);
		var tid = tvar();
		var id = st[sp-1].expr;
		var ty = st[sp-2].type;
		// String literals can be used as keys directly.  All other
		// values must be checked.
		if (/^"[A-Za-z_$][\w_$]*"$/.test(id)) {
			emit('var ' + tid + '=' + st[sp-2].expr + '.' +
						id.substr(1, id.length-2) + ';');
		} else if (/^".*"$/.test(id)) {
			emit('var ' + tid + '=' + st[sp-2].expr + '[' + id + '];');
		} else {
			// Arrays may be views of arrays.
			// Strings may by uint8-strings or strings.
			emit('var ' + tid + '=$get(' + st[sp-2].expr + ',' + id + ');');
		}
		if (st[sp-2].type & TYPE_STRTYP) {
			st[sp-2] = { type:TYPE_INTVAL, expr:tid, seq:++seq };
		} else {
			st[sp-2] = { type:TYPE_UNKNOWN, expr:tid, seq:++seq };
		}
		sp--;
	}

	$.put = function() {
		need(3);
		var id = st[sp-2].expr;
		var ty = st[sp-3].type;
		// String literals can be used as keys directly.  All other
		// values must be checked.
		if (/^"[A-Za-z_$][\w_$]*"$/.test(id)) {
			emit(st[sp-3].expr + '.' + id.substr(1, id.length-2) + '=' +
					st[sp-1].expr + ';');
		} else if (/^".*"$/.test(id)) {
			emit(st[sp-3].expr + '[' + id + ']=' + st[sp-1].expr + ';');
		} else {
			// Arrays may be views.
			// Strings may be uint8-strings or strings (the latter will throw).
			emit('$put(' + st[sp-3].expr + ',' + id + ',' +
					st[sp-1].expr + ');');
		}
		sp-=3;
	}

	$.eq = function() {
		binbool('==', '$eq');
	}
	$.ne = function() {
		binbool('!=', '$ne');
	}
	$.lt = function() {
		binbool('<', '$lt');
	}
	$.le = function() {
		binbool('<=', '$le');
	}
	$.gt = function() {
		binbool('>', '$gt');
	}
	$.ge = function() {
		binbool('>=', '$ge');
	}

	$.and = function() {
		need(2);
		if ((st[sp-1].type & TYPE_NUMTYP) || (st[sp-2].type & TYPE_NUMTYP)) {
			binarith('&');
		} else {
			binbool('&&', '$an');
		}
	}
	$.or = function() {
		need(2);
		if ((st[sp-1].type & TYPE_NUMTYP) || (st[sp-2].type & TYPE_NUMTYP)) {
			binarith('|');
		} else {
			binbool('||', '$or');
		}
	}
	$.xor = function() {
		need(2);
		if ((st[sp-1].type & TYPE_NUMTYP) || (st[sp-2].type & TYPE_NUMTYP)) {
			binarith('^');
		} else {
			// JavaScript does not have logical xor
			st[sp-2].expr = '$xo(' + st[sp-2].expr + ',' + st[sp-1].expr + ')';
			if ((st[sp-1].type&TYPE_BOOLEAN) || (st[sp-2].type&TYPE_BOOLEAN)) {
				st[sp-2].type = TYPE_BOOLEAN;
			} else {
				st[sp-2].type = TYPE_UNKNOWN;	// boolean or number
			}
			sp-=1;
		}
	}
	$.not = function() {
		need(1);

		// Parenthesize complicated expressions.
		var t = st[sp-1].type;

		// Numeric?
		if (t & TYPE_NUMTYP) {
			st[sp-1].expr = '~' + parens(st[sp-1].expr);
		// Boolean?
		} else if (t & TYPE_BOOLEAN) {
			st[sp-1].expr = '!' + parens(st[sp-1].expr);
		} else {
			st[sp-1].expr = '$nt(' + st[sp-1].expr + ')';
		}
		st[sp-1].seq = ++seq;
	}

	// Convert $an(a,b), $or(a,b) and $xo(a,b) to their logical equivalents
	// The compiler emits these functions when types are unknown, but when
	// seen in an if(), we know they are booleans. 
	function unanorxo(expr) {
		return expr.replace(/\$(an|or|xo)\(([\w$]+),([\w$]+)\)/g,
					function($0,$1,$2,$3) {
						if ($1 == 'an') {
							return '(' + $2 + '&&' + $3 + ')';
						}
						if ($1 == 'or') {
							return '(' + $2 + '||' + $3 + ')';
						}
						return '(!' +$2+ '&&' +$3 + '||' + $2 +'&&!' +$3+ ')';
					})
	}


	$.if = function() {
		need(2);
		var expr = unanorxo(st[sp-2].expr);
		var exec = st[sp-1];
		sp-=2;

		// odd-ball case
		//	blah {exch} if
		//
		// That needs to be rewritten so that we do not flush state o/w we
		// cannot trace properly.
		if (sp >= 2 && exec.tokens && exec.tokens.length == 1 &&
				exec.tokens[0].token == 'exch') {
			// Convert the top two expressions to var-refs
			if (!/^_\w+$/.test(st[sp-1].expr)) {
				var tid = tvar();
				emit('var ' + tid + '=' + st[sp-1].expr + ';');
				st[sp-1].expr = tid;
			}
			if (!/^_\w+$/.test(st[sp-2].expr)) {
				var tid = tvar();
				emit('var ' + tid + '=' + st[sp-2].expr + ';');
				st[sp-2].expr = tid;
			}
			emit('if(' + expr + ')' + LC);
			emit('var _=' + st[sp-1].expr + ';');
			emit(st[sp-1].expr + '=' + st[sp-2].expr + ';');
			emit(st[sp-2].expr + '=_;');
			emit(RC);
			return;
		}

		ctxflush();
		ctxprep(exec);
		emit('if(' + expr + ')' + LC);
		newbranch();
		append(ctxexec(exec));
		emit(RC);
	}

	$.ifelse = function() {
		need(3);
		var expr  = unanorxo(st[sp-3].expr);
		var texec = st[sp-2];	// true-branch exec
		var fexec = st[sp-1];	// false-branch exec
		sp-=3;

		// One odd-ball case in BWIPP (inside an array constructor):
		//
		//		blah {{0}} {{1}} ifelse repeat
		//
		// This completely breaks our trace model.  That code is pushing
		// an Immediately Executable object onto the stack at run-time,
		// which the model does not handle.  Since this is the only
		// use-case for this construct (it appears numerous times in the
		// code but is always the same), we will do a one-off fix for it.
		//
		// Future note: if this scheme appears in a different form, the
		// general solution is to create anonymous function objects for
		// the "inside" executable blocks and have `repeat` or whatever
		// target construct invoke the function similar to an Immediately
		// Executable Name.
		if (texec.tokens && texec.tokens.length == 3 &&
				fexec.tokens && fexec.tokens.length == 3 &&
				texec.tokens[0].token == LC && fexec.tokens[0].token == LC &&
				/^\d+$/.test(texec.tokens[1].token) &&
				/^\d+$/.test(fexec.tokens[1].token)) {
			var tid = tvar();
			emit('var ' + tid + '=' + parens(expr) +
						'?' + texec.tokens[1].token +
						':' + fexec.tokens[1].token + ';');
			st[sp++] = { type:TYPE_PRECALC, expr:'$k[$j++]=' + tid, seq:++seq };
			// We've done enough damage here...
			return;
		}

		// Next edge case is similar to the above:
		//		blah {5} {1} ifelse
		//
		// That needs to be rewritten so that we do not flush state o/w we
		// cannot trace properly.
		if (texec.tokens && texec.tokens.length == 1 &&
				fexec.tokens && fexec.tokens.length == 1 &&
				/^\d+$/.test(texec.tokens[0].token) &&
				/^\d+$/.test(fexec.tokens[0].token)) {
			var tid = tvar();
			emit('var ' + tid + '=' + parens(expr) +
						'?' + texec.tokens[0].token +
						':' + fexec.tokens[0].token + ';');
			st[sp++] = { type:TYPE_INTVAL, expr:tid, seq:++seq };
			return;
		}

		ctxflush();
		ctxprep(texec);
		var tlines = ctxexec(texec);
		ctxprep(fexec);
		var flines = ctxexec(fexec);

		emit('if(' + expr + ')' + LC);
		newbranch();
		append(tlines);
		emit(RC + 'else' + LC);
		newbranch();
		append(flines);
		emit(RC);
	}
	$.forall = function() {
		need(2);
		var o    = st[sp-2];
		var exec = st[sp-1];
		sp-=2;

		// azteccode forall loop breaks this...  We need better handling of
		// if/ifelse loops where we do not flush context on exit from the
		// blocks.  It messes up the depth counts when the branch pushes
		// a value that is to be consumed after exit from the branch.
		//if (!(o.type & (TYPE_ARRAY|TYPE_STRTYP|TYPE_DICT)) && exec.tokens) {
		//	// Trace execution to determine what the loop expects.
		//	// ctxpush() empties the array - pass a clone.
		//	ctxflush();
		//	ctxpush(exec.tokens.slice(0));
		//	compile();
		//	var ndeep = depth;
		//	ctxpop();

		//	if (ndeep == 1) {
		//		// Safer than STRTYP since we don't know elt type.
		//		o.type = TYPE_ARRAY;
		//	} else if (ndeep == 2) {
		//		o.type = TYPE_DICT;
		//	}
		//}
		if (o.type & (TYPE_ARRAY|TYPE_STRTYP)) {
			var tid = tvar();
			var len = tvar();
			var val = tvar();

			ctxflush();
			ctxprep(exec);
			emit('for(var ' + tid + '=0,' + len + '=' + o.expr + '.length;' +
					tid + '<' + len + ';' + tid + '++)' + LC);
			newbranch();
			emit('var ' + val + '=$get(' + o.expr + ',' + tid + ');');
			st[sp++] = { type:(o.type&TYPE_ARRAY) ? TYPE_UNKNOWN : TYPE_INTVAL,
						 expr:val, seq:++seq };
			append(ctxexec(exec));
			emit(RC);
		} else if (o.type & TYPE_DICT) {
			var tid = tvar();
			var val = tvar();
			if (o.expr[0] == '_') {
				var obj = o.expr;
			} else {
				var obj = tvar();
			}

			ctxflush();
			ctxprep(exec);
			if (obj != o.expr) {
				emit('var ' + obj + '=' + o.expr + ';');
			}
			emit('for(var ' + tid + ' in ' + obj + ')' + LC);
			newbranch();
			emit('var ' + val + '=' + obj + '[' + tid + '];');
			st[sp++] = { type:TYPE_STRVAL,  expr:tid, seq:++seq };
			st[sp++] = { type:TYPE_UNKNOWN, expr:val, seq:++seq };
			append(ctxexec(exec));
			emit(RC);
		} else {
			ctxflush();

			// Most forall's in BWIPP where we cannot determine object type
			// at compile time use empty exec blocks to push an array's
			// objects onto the stack.  Optimize for that case.
			if (exec.type == TYPE_TOKENS && exec.tokens.length == 0) {
				emit('$forall(' + o.expr + ');');
			} else {
				// Fallback to the slow path - which incurs a function call
				// per iteration.
				ctxprep(exec);

				emit('$forall(' + o.expr + ',function()' + LC);
				newbranch();
				append(ctxexec(exec));
				emit(RC + ');');
			}
		}
	}
	$.for = function() {
		if (sp < 4) {
			dump('for');
			throw 'for: INSUFFICIENT PARAMETERS';
		}
		var eini = st[sp-4].expr;
		var tinc = st[sp-3].type;
		var einc = st[sp-3].expr;
		var tlim = st[sp-2].type;
		var elim = st[sp-2].expr;
		var exec = st[sp-1];
		sp-=4;

		// If the limit is constant, we don't need an extra limit variable.
		if (tlim != TYPE_INTLIT) {
			var vlim = tvar();
		} else {
			var vlim = elim;
		}
		var tid = tvar();


		ctxflush();

		// If increment is not known at compile time, then emit the slow path
		if (tinc != TYPE_INTLIT) {
			var vinc = tvar();
			emit('for(var ' + tid + '=' + eini + ',' + vinc + '=' + einc +
				(tlim != TYPE_INTLIT ? ',' + vlim + '=' + elim : '') + ';' +
				vinc + '<0?' + tid + '>=' + vlim + ':' + tid + '<=' + vlim +
				';' + tid + '+=' + vinc + ')' + LC);
		} else if (+einc < 0) {
			emit('for(var ' + tid + '=' + eini +
				(tlim != TYPE_INTLIT ? ',' + vlim + '=' + elim : '') + ';' +
				tid + '>=' + vlim + ';' + tid + '-=' + (-einc) + ')' + LC);
		} else {
			emit('for(var ' + tid + '=' + eini +
				(tlim != TYPE_INTLIT ? ',' + vlim + '=' + elim : '') + ';' +
				tid + '<=' + vlim + ';' + tid + '+=' + einc + ')' + LC);
		}
		ctxprep(exec);
		st[sp++] = { type:TYPE_INTVAL, expr:tid, seq:++seq };
		newbranch();
		append(ctxexec(exec));
		emit(RC);
	}
	$.repeat = function() {
		need(2);
		var tid = tvar();
		var lim = tvar();
		var expr = st[sp-2].expr;
		var exec = st[sp-1];
		sp-=2;

		ctxflush();
		emit('for(var ' + tid + '=0,' + lim + '=' + expr + ';' +
					tid + '<' + lim + ';' + tid + '++)' + LC);
		ctxprep(exec);
		newbranch();
		append(ctxexec(exec));
		emit(RC);
	}
	$.loop = function() {
		need(1);
		var exec = st[sp-1];
		sp-=1;

		ctxflush();
		ctxprep(exec);
		emit('for(;;)' + LC);
		newbranch();
		append(ctxexec(exec));
		emit(RC);
	}
	$.exit = function() {
		ctxflush();
		emit('break;');
	}

	$.mark = function() {
		ctxflush();
		emit('$k[$j++]=Infinity;');
	}
	$.counttomark = function() {
		var tid = tvar();
		//ctxflush();
		if (sp) {
			emit('var ' + tid + '=$counttomark()+' + sp + ';');		// EMBED
		} else {
			emit('var ' + tid + '=$counttomark();');				// EMBED
		}
		st[sp++] = { type:TYPE_INTVAL, expr:tid, seq:++seq };
	}
	$.cleartomark = function() {
		ctxflush();
		emit('$cleartomark();');		// EMBED
	}
	$.clear = function() {
		ctxflush();
		emit('$j=0;');
	}

	$.mul = function() {
		binarith('*');
	}
	$.div = function() {
		binarith('/');
	}
	$.mod = function() {
		binarith('%');
	}
	$.add = function() {
		binarith('+');
	}
	$.sub = function() {
		binarith('-');
	}
	// integer division
	$.idiv = function() {
		need(2);
		var t1 = st[sp-1].type;
		var t2 = st[sp-2].type;

		// idiv takes the floor towards 0 which is the effect of ~~ in JavaScript.
		// Math.floor() takes the floor towards the smallest integer.
		//	ps> -5 2 idiv --> -2
		//	js> ~~(-5 / 2) --> -2
		//	js> Math.floor(-5 / 2) --> -3
		if ((t1 & (TYPE_INTLIT|TYPE_NUMLIT)) && (t2 & (TYPE_INTLIT|TYPE_NUMLIT))) {
			st[sp-2].expr = '' + ~~(+st[sp-2].expr / +st[sp-1].expr);
			st[sp-2].type = TYPE_INTLIT;
		} else {
			st[sp-2].expr = '~~(' + parens(st[sp-2].expr) + '/' +
									parens(st[sp-1].expr) + ')';
			st[sp-2].type = TYPE_INTVAL;
		}
		st[sp-2].seq = ++seq;
		sp--;
	}
	$.exp = function() {
		need(2);
		var expo = st[--sp].expr;
		var base = st[--sp].expr;
		st[sp++] = { type:TYPE_NUMVAL,
					 expr:'Math.pow(' + base + ',' + expo + ')',
					 seq:++seq };
	}
	$.ln = function() {
		need(1);
		st[sp-1] = { type:TYPE_NUMVAL,
					 expr:'Math.log(' + st[sp-1].expr + ')',
					 seq:++seq };
	}
	$.log = function() {
		need(1);
		st[sp-1] = { type:TYPE_NUMVAL,
					 expr:'Math.log(' + parens(st[sp-1].expr) + '/Math.LN10)',
					 seq:++seq };
	}
	$.neg = function() {
		need(1);

		// Simple expression?
		st[sp-1].expr = '-' + parens(st[sp-1].expr);
		st[sp-1].type = st[sp-1].type || TYPE_NUMVAL;
		st[sp-1].seq = ++seq;
	}
	$.abs = function() {
		need(1);
		st[sp-1].expr = 'Math.abs(' + st[sp-1].expr + ')';
		st[sp-1].type = st[sp-1].type || TYPE_NUMVAL;
		st[sp-1].seq  = ++seq;
	}
	$.round = function() {
		need(1);
		st[sp-1] = { type:TYPE_INTVAL, expr:'Math.round(' +st[sp-1].expr+ ')',
					seq:++seq };
	}
	$.floor = function() {
		need(1);
		st[sp-1] = { type:TYPE_INTVAL, expr:'Math.floor(' +st[sp-1].expr+ ')',
					seq:++seq };
	}
	$.ceiling = function() {
		need(1);
		st[sp-1] = { type:TYPE_INTVAL, expr:'Math.ceil(' +st[sp-1].expr+ ')',
					seq:++seq };
	}
	$.sqrt = function() {
		need(1);
		st[sp-1] = { type:TYPE_NUMVAL, expr:'Math.sqrt(' +st[sp-1].expr+ ')',
					seq:++seq };
	}
	$.bitshift = function() {
		need(2);
		var sft = st[--sp];
		var val = st[--sp].expr;
		if (sft.type == TYPE_INTLIT) {
			var bits = +sft.expr;
			if (bits < 0) {
				st[sp++] = { type:TYPE_INTVAL, expr:parens(val) +'>>>'+ (-bits),
							 seq:++seq };
			} else {
				st[sp++] = { type:TYPE_INTVAL, expr:parens(val) + '<<' + bits,
							 seq:++seq };
			}
		} else {
			// This evaluates the shift-expression twice and emits it thrice.
			// Assign a temp variable if not already a variable.
			if (!/^_[\w$_]+$/.test(sft.expr)) {
				var tid = tvar();
				emit('var ' + tid + '=' + sft.expr + ';');
				sft.expr = tid;
			}
			st[sp++] = { type:TYPE_INTVAL,
						 expr:'(' + parens(sft.expr) + '<0?' +
						 			parens(val) +'>>>'+ '-' + sft.expr + ':'+
									parens(val) + '<<'+ parens(sft.expr) + ')',
						 seq:++seq };
		}
	}


	$.array = function() {
		need(1);
		var tid = tvar();
		emit('var ' + tid + '=$a(' + st[sp-1].expr + ');');
		st[sp-1] = { type:TYPE_ARRAY, expr:tid, seq:++seq };
	}

	$.aload = function() {
		need(1);
		var lnbr = lex.lnbr;
		var expr = st[--sp].expr;

		// All uses of aload by BWIPP discard the array left on the top
		// of the stack after aload completes.  Therefore, our implementation
		// of aload does not push the array.  And we must check that BWIPP
		// is indeed popping after aloading.
		if (lex.peek() != 'pop') {
			throw '#' + lnbr + ': aload without pop';
		}

		// We are about to modify stack in an unknown way, sync state
		ctxflush();
		emit('$aload(' + expr + ');');		// EMBED

		// Discard the pop
		lex.next();
	}
	$.astore = function() {
		need(1);	// just the array
		var expr = st[--sp].expr;

		// We are about to modify stack in an unknown way, sync state
		ctxflush();
		emit('$astore(' + expr + ');');		// EMBED
	}

	$.string = function() {
		need(1);
		var tid = tvar();
		emit('var ' + tid + '=$s(' + st[sp-1].expr + ');');	// EMBED
		st[sp-1] = { type:TYPE_STRVAL, expr:tid, seq:++seq };
	}

	$.getinterval = function() {
		need(3);
		var typ = st[sp-1].type;
		var len = st[--sp].expr;
		var off = st[--sp].expr;
		var src = st[--sp].expr;
		var tid = tvar();
		emit(`var ${tid}=$geti(${src},${off},${len});`);	// EMBED
		if (typ & TYPE_STRTYP) {
			st[sp++] = { type:TYPE_INTVAL, expr:tid, seq:++seq };
		} else {
			st[sp++] = { type:TYPE_UNKNOWN, expr:tid, seq:++seq };
		}
	}
	$.putinterval = function() {
		need(3);
		var src = st[--sp].expr;
		var off = st[--sp].expr;
		var dst = st[--sp].expr;
		emit('$puti(' + dst + ',' + off + ',' + src + ');');	// EMBED
	}

	// haystack needle search post match pre true
	//                        haystack false
	$.search = function() {
		need(2);
		var sub = st[--sp].expr;
		var src = st[--sp].expr;

		// The stack state is unknown after search returns.
		ctxflush();
		emit(`$search(${src},${sub});`);		// EMBED
	}

	$.gsave = function() {
		emit('$$.save();');								// CANVAS
	}
	$.grestore = function() {
		emit('$$.restore();');							// CANVAS
	}

	// Custom interface to indicate the minimum drawing surface based on
	// the border path that BWIPP draws.
	$.setextent = function() {
		emit('$$.setextent();');
	}

	$.currentpoint = function() {
		var tid = tvar();
		emit('var ' + tid + '=$$.currpos();');			// CANVAS
		st[sp++] = { type:TYPE_NUMVAL, expr:tid + '.x', seq:++seq };
		st[sp++] = { type:TYPE_NUMVAL, expr:tid + '.y', seq:++seq };
	}

	$.scale = function() {
		need(2);
		var x = st[sp-2].expr;
		var y = st[sp-1].expr;
		sp-=2;
		emit('$$.scale(' + x + ',' + y + ');');			// CANVAS
	}

	$.translate = function() {
		need(2);
		var x = st[sp-2].expr;
		var y = st[sp-1].expr;
		sp-=2;
		emit('$$.translate(' + x + ',' + y + ');');		// CANVAS
	}

	// dtransform is a no-op but ... BWIPP uses the 3-operand form
	$.dtransform = function() {
		need(3);
		sp--;
	}

	$.currentfont = function() {
		var tid = tvar();
		emit('var ' + tid + '=$$.currfont();');			// CANVAS
		st[sp++] = { type:TYPE_DICT, expr:tid, seq:++seq };
	}
	$.findfont = function() {
		need(1);
		var f = st[sp-1].expr;
		sp-=1;
		var tid = tvar();
		emit('var ' + tid + '=$$.findfont(' + f + ');');// CANVAS
		st[sp++] = { type:TYPE_DICT, expr:tid, seq:++seq };
	}
	$.scalefont = function() {
		need(2);
		var x = st[sp-1].expr;
		var f = st[sp-2].expr;
		sp-=2;
		emit(parens(f) + '.FontSize=' + x + ';');		// CANVAS
		st[sp++] = { type:TYPE_DICT, expr:f, seq:++seq };
	}
	$.setfont = function() {
		need(1);
		var f = st[sp-1].expr;
		sp-=1;
		emit('$$.setfont(' + f + ');');					// CANVAS
	}
	$.ashow = function() {
		need(3);
		var dx = st[sp-3].expr;
		var dy = st[sp-2].expr;
		var s  = st[sp-1].expr;
		sp-=3;
		emit('$$.show('+s+','+dx+','+dy+');');			// CANVAS
	}
	$.show = function() {
		need(1);
		var s = st[sp-1].expr;
		sp-=1;
		emit('$$.show(' + s + ',0,0);');				// CANVAS
	}
	$.charpath = function() {
		need(2);
		var s = st[sp-2].expr;
		var b = st[sp-1].expr;
		sp-=2;
		emit('$$.charpath(' + s + ',' + b + ');');		// CANVAS
	}
	$.pathbbox = function() {
		var tid = tvar();
		emit('var ' + tid + '=$$.pathbbox();');			// CANVAS
		st[sp++] = { type:TYPE_NUMVAL, expr:tid + '.llx', seq:++seq };
		st[sp++] = { type:TYPE_NUMVAL, expr:tid + '.lly', seq:++seq };
		st[sp++] = { type:TYPE_NUMVAL, expr:tid + '.urx', seq:++seq };
		st[sp++] = { type:TYPE_NUMVAL, expr:tid + '.ury', seq:++seq };
	}
	$.stringwidth = function() {
		need(1);
		var s = st[sp-1].expr;
		sp-=1;
		var tid = tvar();
		emit('var ' + tid + '=$$.stringwidth(' + s + ');'); 	// CANVAS
		st[sp++] = { type:TYPE_NUMVAL, expr:tid + '.w', seq:++seq };
		st[sp++] = { type:TYPE_NUMVAL, expr:tid + '.h', seq:++seq };
	}

	$.imagemask = function() {
		need(5);
		var datasrc	 = st[--sp].expr;		// non-standard string
		var matrix	 = st[--sp].expr;		// ignored/not-used
		var polarity = st[--sp].expr;		// always true
		var	height	 = st[--sp].expr;
		var width	 = st[--sp].expr;
		emit('$$.imagemask(' + width + ',' + height + ',' + datasrc + ');');
	}

	$.setlinewidth = function() {
		need(1);
		var w = st[sp-1].expr;
		sp-=1;
		emit('$$.setlinewidth(' + w + ');');			// CANVAS
	}
	// bwipjs emulated function to replace BWIPP's setanycolor
	$.setcolor = function() {
		need(1);
		var expr = st[--sp].expr;
		emit('$$.setcolor(' + expr + ');');				// CANVAS
	}
	// no-op
	$.setlinecap = function() {
		need(1);
		//var c = st[sp-1].expr;
		sp-=1;
		//emit('$$.setlinecap('+c+');');					// CANVAS
	}
	// no-op
	$.setlinejoin = function() {
		need(1);
		//var c = st[sp-1].expr;
		sp-=1;
		//emit('$$.setlinejoin('+c+');');					// CANVAS
	}
	$.stroke = function() {
		emit('$$.stroke();');							// CANVAS
	}
	$.newpath = function() {
		emit('$$.newpath();');							// CANVAS
	}
	$.closepath = function() {
		emit('$$.closepath();');						// CANVAS
	}
	$.moveto = function() {
		need(2);
		var x = st[sp-2].expr;
		var y = st[sp-1].expr;
		sp-=2;
		emit('$$.moveto(' + x + ',' + y + ');');		// CANVAS
	}
	$.lineto = function() {
		need(2);
		var x = st[sp-2].expr;
		var y = st[sp-1].expr;
		sp-=2;
		emit('$$.lineto(' + x + ',' + y + ');');		// CANVAS
	}
	$.rlineto = function() {
		need(2);
		var x = st[sp-2].expr;
		var y = st[sp-1].expr;
		sp-=2;
		emit('$$.rlineto(' + x + ',' + y + ');');		// CANVAS
	}
	$.rmoveto = function() {
		need(2);
		var x = st[sp-2].expr;
		var y = st[sp-1].expr;
		sp-=2;
		emit('$$.rmoveto(' + x + ',' + y + ');');		// CANVAS
	}
	$.fill = function() {
		emit('$$.fill();');								// CANVAS
	}
	$.arc = function() {
		need(5);
		var a2 = st[--sp].expr;
		var a1 = st[--sp].expr;
		var r  = st[--sp].expr;
		var y  = st[--sp].expr;
		var x  = st[--sp].expr;
		emit(`$$.arc(${x},${y},${r},${a1},${a2},1);`);	// CANVAS 1 == CCW
	}
	$.arcn = function() {
		need(5);
		var a2 = st[--sp].expr;
		var a1 = st[--sp].expr;
		var r  = st[--sp].expr;
		var y  = st[--sp].expr;
		var x  = st[--sp].expr;
		emit(`$$.arc(${x},${y},${r},${a1},${a2},0);`);	// CANVAS 0 == CW
	}

	// Finally, do the actual compilation
	if (cfg.coverage) {
		emit('var $bwipjs_functions=[];');
	}
	compile();
	if (cfg.coverage) {
		emit('typeof require=="function"&&' +
			 'require("fs").writeFileSync("coverage/functions",' +
			 '$bwipjs_functions.join("\\n")+"\\n","binary");');
	}
	var lines = '';
	for (var i = 0; i < block.length; i++) {
		lines += block[i].code + '\n';
	}
	return lines;
}

// Modularize for node.js
if (typeof module == 'object' && module.exports) {
	module.exports = PSC;
}
