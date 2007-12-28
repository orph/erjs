/* Er.js
 * Erlang-style concurrency and message passing library, using JavaScript 1.7.
 * Author: Alex Graveley, alex@beatniksoftware.com, http://beatniksoftware.com/
 *
 * Based on Thread.js
 * A library for threading using JavaScript 1.7 generators and trampolining.
 * Author: Neil Mix, neilmix [at] gmail [dot] com, http://www.neilmix.com/
 *
 * Please feel free to use this code in any way that pleases you.  If
 * appropriate, drop me an email because I like hearing about interesting 
 * projects.
 */


// Use this in message matching patterns passed to Er.register in
// order to match any value for a message key.  '_' can also be used
// as the key name to match any key.
var _ = 0xDEADBEEF;


var Er = {
   /* 
    * Public API...
    */

   // Linked processes send this Signal value to their links 
   // when exiting.  The message is of the form: 
   //   { Signal: Er.Exit, From: <exiting pid>, Reason: <reason> }
   Exit: { toString: function() { return "[object Er.Exit]" } },

   // Regular process exit uses this as the Reason value.
   Normal: { toString: function() { return "[object Er.Normal]" } },

   // Start a function in a new process, optionally passing
   // arguments.  The function can be a generator.  If no arguments
   // are specified, [] is passed.  Usage:
   //   pid = Er.spawn(function () { ... } [, args...])
   spawn: function(fun) {
      var args = Array.prototype.slice.call(arguments, 1);
      return Er._addproc(fun, args, false)._pid;
   },

   // Same as Er.spawn, but link the current process to the spawned 
   // process' exit signal.  Usage:
   //   pid = Er.spawn_link(function () { ... } [, args...])
   spawn_link: function(fun) {
      var args = Array.prototype.slice.call(arguments, 1);
      return Er._addproc(fun, args, true)._pid;
   },

   // Get the current process pid
   pid: function() {
      return Er._current._pid;
   },

   // Register a pid to receive messages sent to a name string.  
   // Multiple processes can register the same name, and a process
   // can have multiple registered names.
   register: function(name, pid) {
      if (Er._names[pid].indexOf(name) < 0)
          Er._names[pid].push(name);
   },

   // Return a list of pids registered to a name.
   registered: function(name) {
      return [Number(pid) for (pid in Er._names)
              if (Er._names[pid].indexOf(name) > -1)];
   },

   // Send a message, in the form of an associative array to the / given pid or
   // registered name.  The msg argument is copied for each destination process,
   // and original always returned. Usage:
   //    msg = Er.send(<pid|name>, { Key: Value, ... });
   send: function(id, msg) {
      Er._pidof(id).forEach(function(pid) {
         Er._pids[pid]._send(Er._copy(msg));
      });
      return msg;
   },

   // Link the current process to id's exit signal, where id is a pid
   // or registered name.
   link: function(pid) {
      Er._links[pid][Er._current._pid] = true;
      Er._links[Er._current._pid][pid] = true;
   },

   // Unlink the current process from id's exit signal.
   unlink: function(pid) {
      delete Er._links[pid][Er._current._pid];
      delete Er._links[Er._current._pid][pid];
   },

   /* Exit the current process or another pid, with optional exit
    * Reason passed to linked processes.  If no reason is specified,
    * Er.Normal exit is assumed, and no messages sent.  Usage:
    *    Er.exit();             // Exit current with Er.Normal
    *    Er.exit(aReason);      // Exit current with aReason
    *    Er.exit(pid, aReason); // Exit pid with aReason
    */
   exit: function() {
      switch(arguments.length) {
      case 2:
         if (arguments[1] != Er.Normal) {
            Er._pids[arguments[0]]._send({ Signal: Er.Exit,
                                           From: Er.pid(),
                                           Reason: arguments[1] });
         }
         break;
      case 1:
         Er._current._exit(arguments[0]);
         break;
      case 0:
         Er._current._exit(Er.Normal);
         break;
      }
   },

   /* NOTE: Requires yield.  Receive a single message sent to this
    * pid, by matching a list of patterns against an incoming
    * message.  Patterns are followed by a handler function, listed
    * after patterns.  The final return value is the return value of
    * the invoked handler.  Usage:
    *   val = yield Er.receive(
    *         // List of patterns to match
    *      { MyKey: 123 },      // Explicit matches...
    *      { MyKey: "abc" },    // ... Strings
    *      { MyKey: obj },      // ... References
    *      { MyKey: TypeName }, // Instance of a type 
    *      { MyKey: { ... } },  // Nested matching
    *      { MyKey: _ },        // Any value
    *         // Handler function follows patterns
    *      function(msg) { alert(msg.MyKey); },
    *         // More patterns/handlers
    *      { A: ..., B: ... },  // Multiple keys
    *      { _: ... },          // Any keyname
    *      { _: _ },            // Any key, any value
    *      function(msg) { ... });
    */
   receive: function() {
      return Er._current._receive(arguments);
   },

   // NOTE: Requires yield.  Sleep a number of milliseconds before
   // continuing the process.  Usage:
   //   yield Er.sleep(1000); // 1 second
   sleep: function(millis) {
      return Er._current._sleep(millis);
   },

   /*
    * Private ErProc, links, and registered name helpers...
    */

   _pids: [],  // [pid] = ErProc instance
   _names: [], // [pid] = [name, ...]
   _links: [], // [pid] = [dest_pid, ...]
   _mainproc: null,
   _current: null,

   // Start the main process.  This is pid 0.
   _init: function() {
      Er._mainproc = Er._current = Er._addproc(function() {
         while (true) {
            // Hang around to receive messages.
            yield Er.sleep(10000);
         }
      }, null, null);
   },

   // Create and run a new ErProc process which will call fun(args),
   // possibly creating an initial link to link_pid.
   _addproc: function(fun, args, linked) {
      var newpid = 0;
      while (Er._pids[newpid])
         newpid++;
      var newproc = new ErProc(newpid, fun, args);

      Er._pids[newpid] = newproc;
      Er._names[newpid] = [];
      Er._links[newpid] = [];
      if (linked)
         Er.link(newpid);

      newproc._start();
      return newproc;
   },

   // Cleanup after pid exits, sending exit messages to linked
   // processes.
   _removeproc: function(pid, exitreason) {
      delete Er._pids[pid];
      delete Er._names[pid];

      for (linkpid in Er._links[pid]) {
         linkpid = Number(linkpid);

         // Clear in case linkpid survives
         delete Er._links[linkpid][pid];

         if (exitreason != Er.Normal) {
            // Can't use Er.exit, as _removeproc might be called out 
            // of the running process.
            Er._pids[linkpid]._send({ Signal: Er.Exit,
                                      From: pid,
                                      Reason: exitreason });
         }
      }
      delete Er._links[pid];
   },

   // Get the list of pids for a given registered name.  Passing a
   // pid or ErProc will do the obvious.
   _pidof: function(id) {
      if (typeof(id) == "number") {
         return Er._pids[id] ? [id] : []; // Ignore missing pids
      } else if (id instanceof ErProc) {
         return [id._pid];
      } else {
         var pids = Er.registered(id);
         if (pids.length == 0)
            throw("Er: Process name not registered: " + 
                  id + " (" + typeof(id) + ")");
         return pids;
      }
   },

   // Recursively duplicate an object.  Each sent message is copied
   // before forwarding to the destination.
   _copy: function(obj) {
      if (typeof(obj) != "object" || !obj || 
          obj instanceof Document ||
          obj instanceof Element ||
          obj instanceof Event)
         return obj;

      var ret;
      if (obj.constructor == Date ||
          obj.constructor == String ||
          obj.constructor == Number) {
         ret = new obj.constructor(obj);
      } else if (obj.constructor == Array) {
         ret = new Array();
      } else {
         ret = new Object();
         ret.constructor = obj.constructor;
      }

      ret.prototype = obj.prototype;
      for (i in obj) {
         ret[i] = Er._copy(obj[i]);
      }

      return ret;
   }
};


function ErProc(pid, fun, args) {
   this._pid = pid;
   this._queue = [];
   this._stack = [];

   this._start = function() {
      this._run(this._threadmain(fun, args), false);
   };

   var _this = this;
   this._resume = function(retval) {
      if (_this._stack.length) {
         _this._run(retval, false);
      }
   };
}
ErProc.prototype = {
   constructor: ErProc,

   /*
    * Callbacks from Er on the current ErProc...
    */

   // Start running fun(args), and yield the result.  Catch 
   // exceptions and use as the exitreason sent to Er._removeproc.
   _threadmain: function(fun, args) {
      var retval = Er.Normal;
      try {
         // Wait until the document is loaded.
         while (!document.body) {
            yield Er.sleep(100);
         }
         yield fun.apply({}, args);
      } catch(e if e == StopIteration) {
         // Normal exit
      } catch(e) {
         retval = e;
      }
      Er._removeproc(this._pid, retval);
   },

   // Throw the reason in the current execution stack, to be finally caught by
   // _threadmain, or kill the stack if this process isn't currently running.
   _exit: function(reason) {
      if (Er._current == this) {
         throw reason;
      } else {
         while (this._stack.length) {
            this._stack.pop().close();
         }
         Er._removeproc(this._pid, reason);
      }
   },

   // See Er.receive description for what this is supposed to do.  Hashtable
   // match requires matching all submembers, unless a '_' key is specified.
   // Arrays match any one submember matching.
   _match: function(pattern, value) {
      if (pattern == _ ||
          pattern == value ||
          pattern == value.constructor)
         return true;

      if (!value instanceof Object)
         return false;

      if (pattern instanceof Array) {
         for (idx in pattern) {
            for (vidx in value) {
               if (this._match(pattern[idx], value[vidx]))
                  return true;
            }
            return false;
         }
         return value.length == 0;
      } else {
         var match_any = "_" in pattern;
         for (name in pattern) {
            if (!match_any && !value.hasOwnProperty(name))
               return false;
            if (!this._match(pattern[name], value[name]))
               return false;
         }
      }

      return true;
   },

   // Collect patterns/handlers and read messages off the queue until a match is
   // found.  Call the pattern's handler and yield the result.
   _receive: function(args) {
      var patterns = [];

      try {
         for (var i = 0; i < args.length; i++) {
            var patlist = [];
            var handler = null;

            for (; i < args.length; i++) {
               if (typeof(args[i]) == "function") {
                  handler = args[i];
                  break;
               } else {
                  patlist.push(args[i]);
               }
            }

            if (patlist.length == 0)
               throw("Er.receive: found no patterns");
            if (handler == null)
               throw("Er.receive: no handler for patterns");

            for (var j = 0; j < patlist.length; j++) {
               patterns.push([patlist[j], handler]);
            }
         }
      } catch (e) {
         throw("Er.receive: unexpected error in arguments: " + e);
      }

      if (!patterns.length)
         throw("Er.receive: no valid patterns!");

      var done = false;
      var retmsg = null;
      var pending = [];

   loop:
      while (!done) {
         var msg;
         while ((msg = this._queue.shift())) {
            for (var i = 0; i < patterns.length; i++) {
               if (this._match(patterns[i][0], msg)) {
                  retmsg = patterns[i][1](msg);
                  done = true;
                  break loop;
               }
            }
            pending.push(msg);
         }

         // Give the queue a chance to fill again / avoid starving others
         yield Er.sleep(100);
      }

      this._queue = pending.concat(this._queue);
      yield retmsg;
   },

   _send: function(msg) {
      if (msg.Signal == Er.Exit && msg.Reason != Er.Normal) {
         this._exit(msg.Reason);
      } else {
         this._queue.push(msg);
      }
   },

   _sleep: function(millis) {
      setTimeout((yield this._CONTINUATION), millis);
      yield this._SUSPEND;
   },

   /* special yield value which tells a Thread to suspend execution */
   _SUSPEND: { toString: function() { return "[object ErProc._SUSPEND]" } },

   /* special yield value which tells a Thread to send a continuation callback
    * for resuming a thread */
   _CONTINUATION: { toString: function() { return "[object ErProc._CONTINUATION]" } },

   // Execute this ErProc using trampolining... this is copied
   // directly from Threads.js.  Changed to always set/unset the
   // Er._current global.
   _run: function(retval, isException) {
      while (true) {
         var method;
         var arg = undefined;
         if (isException) {
            this._stack.pop().close();
            if (this._stack.length) {
               // propagate the exception down the stack
               method = "throw";
               arg    = retval;
            } else {
               // we're done
               return;
            }
         } else if (retval == this._CONTINUATION) {
            // generator is requesting our resume callback
            method = "send";
            arg    = this._resume;
         } else if (retval == this._SUSPEND) {
            // generator has requested we suspend
            return;
         } else if (retval != null && 
                    typeof(retval) == "object" &&
                    typeof(retval.next) == "function" && 
                    typeof(retval.send) == "function") {
            // it's a generator that was returned.
            // add it as a new frame on the stack.
            this._stack.push(retval);
            method = "next";
         } else {
            // regular return value
            // end the current frame
            this._stack.pop().close();
            if (this._stack.length) {
               // return to the previous frame
               method = "send";
               arg    = retval;
            } else {
               // we're done.
               return;
            }
         }

         // Always set the current Er process before invoking callbacks.
         // Always revert it back once we return.
         var lastproc = Er._current;
         Er._current = this;
         try {
            retval = this._stack[this._stack.length-1][method](arg);
            isException = false;
         } catch(e if e == StopIteration) {
            // since a normal return results in StopIteration, we'll
            // just treat this as a return
            retval = undefined;
            isException = false;
         } catch(e) {
            retval = e;
            isException = true;
         } finally {
            Er._current = lastproc;
         }
      }
   },
};


// Start the main process.
Er._init();


Er.AjaxOptions = function() { };
Er.AjaxOptions.prototype = {
   Username: null,
   Password: null,
   Method: null,         // Override POST with data, GET without
   Request: {
      Headers: { },      // Header: value to send
      ContentType: null, // Override "application/x-www-form-urlencoded"
   },
   Response: {
      Headers: [],       // List of header names to return
      ContentType: null, // Override server's Content-Type
   },
   Timeout: 0,
   UseCache: false,
   IfModified: true,     // Set La
   NotifyHeaders: false,
   NotifyPartial: false
};


Er.Ajax = {
   DefaultOptions: new Er.AjaxOptions(),

   _lastModified: {}, // url: date-string

   // NOTE: Requires yield.  Er.Ajax.spawn wrapper to POST to a URL
   // (pseudo-)synchronously.  Waits until receiving a message from
   // the spawn'd process with the Success field set, and returns
   // that message.
   post: function(url, data, options) {
      var pid = Er.Ajax.spawn(Er.pid(), url, data, options);
      return Er.receive({ From: pid, Success: _, _:_ },
                        function(msg) { return msg; });
   },

   // NOTE: Requires yield.  Like Er.Ajax.post, but GET content.
   get: function(url, options) {
      return Er.Ajax.post(url, null, options);
   },

   /* NOTE: Requires yield.  Spawn a new process to download URL,
    * possibly POSTing data.  Er.Ajax.DefaultOptions are used if no
    * options are specified.
    * The pid arg will receive messages of the form: 
    *    { From:       Spawn'd Pid
    *      Url:        URL,
    *      Success:    true/false if finished,
    *      Text:       URL body text
    *      XmlDoc:     XMLDocument if response is XML
    *      Status:     HTTP status code,
    *      StatusText: HTTP status text,
    *      Headers:    { Optional response headers name/val } }
    * The final message will have a Success boolean set, and the
    * process will exit normally regardless of Success.  Usage: 
    *    pid = yield Er.Ajax.spawn(pid, url, [, data [, Er.AjaxOptions]]);
    */
   spawn: function(from, url, data, options) {
      return Er.spawn(function (from, url, data, options) {
         // Create the request object; Microsoft failed to properly implement the
         // XMLHttpRequest in IE7, so we use the ActiveXObject when it is available
         var xml = new XMLHttpRequest();

         // Open the socket (async)
         xml.open(options.Method || (data ? "POST" : "GET"), url, true, 
                  options.Username, options.Password);

         var _pid = Er.pid();
         xml.onreadystatechange = function() {
            if (!xml || (xml.readyState == 2 && !options.NotifyHeaders) ||
                (xml.readyState == 3 && !options.NotifyPartial) ||
                xml.readyState != 4)
               return;

            var msg = { From: _pid,
                        Url: url,
                        Status: xml.status,
                        StatusText: xml.statusText,
                        Text: xml.responseText };

            if (options.Response.Headers.length) {
               msg.Headers = {};
               for (idx in options.Response.Headers)
                  msg.Headers[header] = 
                     xml.getResponseHeader(options.Response.Headers[idx]);
            }

            // Update last-modified cache
            var lm = Er.Ajax._lastModified[url];
            try { lm = xml.getResponseHeader("Last-Modified") } catch (e) {}
            if (options.IfModified && lm)
               Er.Ajax._lastModified[url] = lm;

            if (xml.readyState == 4) {
               // Get the finished xml document
               var ct = options.Response.ContentType;
               try { ct = xml.getResponseHeader("content-type") } catch (e) {}
               if (ct && ct.indexOf("xml") >= 0)
                  msg.XmlDoc = xml.responseXML;

               msg.Success = (!xml.status && location.protocol == "file:") ||
                  (xml.status >= 200 && xml.status < 300 ) ||
                  xml.status == 304;

               Er.send(_pid, { Done: true });
               xml = null;
            }

            Er.send(from, msg);
         };

         // Set the If-Modified-Since header, if ifModified mode.
         if (options.IfModified)
            xml.setRequestHeader("If-Modified-Since",
               Er.Ajax._lastModified[url] || "Thu, 01 Jan 1970 00:00:00 GMT" );

         // Set header so the called script knows that it's an XMLHttpRequest
         xml.setRequestHeader("X-Requested-With", "XMLHttpRequest");

         // Set user-specified headers
         for (header in options.Request.Headers)
            xml.setRequestHeader(header, options.Request.Headers[header]);

         // Set the correct header, if data is being sent
         if (data)
            xml.setRequestHeader("Content-Type", 
               options.Request.ContentType || "application/x-www-form-urlencoded");

         // XXX: format data
         xml.send(data);

         yield Er.receive({ Done: true },
                          function(msg) { },
                          { Cancel: true },
                          function(msg) {
                             if (xml) {
                                xml.abort();
                                xml = null;
                             }
                             Er.exit(msg);
                          });
      }, from, url, data, options || Er.Ajax.DefaultOptions);
   }
};


Er.DOM = {
   receive: function(elem, evtype, capture, stop) {
      var _pid = Er.pid();
      var listener = {
         handleEvent: function(ev) {
            Er.send(_pid, { Element: elem,
                            Event: ev,
                            Type: evtype,
                            Capture: capture });
            if (stop) {
               event.preventDefault();
               event.stopPropagation();
            }
         }
      };
      elem.addEventListener(evtype, listener, capture);
      var ev = yield Er.receive({ Element: elem,
                                  Event: _,
                                  Type: evtype,
                                  Capture: capture },
                                function (msg) { return msg.Event });
      elem.removeEventListener(evtype, listener, capture);
      yield ev;
   }
};
