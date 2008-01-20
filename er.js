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


// Use this in message matching patterns passed to Er.receive in
// order to match any value for a message key.  '_' can also be used
// as the key name to match any key.
var _ = 0xDEADBEEF;


var Er = {
   /* 
    * Public API...
    */

   // Linked processes send this Signal value to their links when
   // exiting to trigger exit chaining.  The full message is:
   //    { Signal: Er.Exit, From: <exiting pid>, Reason:
   Exit: { toString: function() { return "[object Er.Exit]" } },

   // Regular process exit uses this as the Reason value.
   Normal: { toString: function() { return "[object Er.Normal]" } },

   // Start a function in a new process, optionally passing
   // arguments.  The function can be a generator.  Usage:
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

   // Send a message, in the form of an associative array to pid or
   // registered name.  The msg argument is copied for each
   // destination process, and the original always returned. Usage:
   //    msg = Er.send(<pid|name>, { Key: Value, ... });
   send: function(id, msg) {
      Er._pidof(id).forEach(function(pid) {
         Er._pids[pid]._send(Er._copy(msg));
      });
      return msg;
   },

   // Link the current process to pid's exit signal, and vice versa.
   link: function(pid) {
      Er._links[pid][Er._current._pid] = true;
      Er._links[Er._current._pid][pid] = true;
   },

   // Unlink the current process from pid's exit signal, and vice versa.
   unlink: function(pid) {
      delete Er._links[pid][Er._current._pid];
      delete Er._links[Er._current._pid][pid];
   },

   /* Exit the current process or another pid, with optional exit
    * reason passed to linked processes.  If no reason is specified,
    * Er.Normal exit is assumed, and no messages sent.  Usage:
    *    Er.exit();             // Exit current with Er.Normal
    *    Er.exit(reason);       // Exit current with aReason
    *    Er.exit(pid, reason);  // Exit pid with aReason
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
    * pid, by matching a list of patterns against incoming messages
    * in order of arrival.  Unmatched messages are left in the
    * queue. Patterns are followed by a handler function, invoked
    * with the matching message.  The return value of the handler is
    * returned to the caller.  Usage:
    *   val = yield Er.receive(
    *         // List of patterns to match
    *      { MyKey: 123 },      // Explicit matches...
    *      { MyKey: "abc" },    // ... Strings
    *      { MyKey: obj },      // ... References
    *      { MyKey: TypeName }, // Instance of a type 
    *      { MyKey: { ... } },  // Nested matching
    *      { MyKey: _ },        // Any value
    *         // Handler function follows patterns
    *      function(msg) { return msg.MyKey; },
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
      return Er._current._sleep(millis || 0);
   },

   // Returns a new function wrapper around fun, which when invoked
   // converts '_' arguments to a continuation for the calling
   // process before invoking fun.  Use this to convert asynchronous
   // JS methods with a completion callback to act like a sync call.
   // Usage:
   //    elem.show = Er.wrap(elem.show); // show takes a duration & done callback
   //    yield elem.show(1200, _);
   wrap: function(fun, obj) {
      return function() {
         for (var idx = 0; idx < arguments.length; idx++)
            if (arguments[idx] == _)
               arguments[idx] = Er._current._resume;

         if (typeof(fun) == "string")
            fun = (obj || this)[fun];

         var ret = fun.apply(obj || this, arguments);
         yield this._SUSPEND;
         yield ret;
      }
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
   // before forwarding to the destination.  DOM Documents, Elements,
   // and Events are referenced directly.
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

   // Throw the reason as an exception, to be caught up the stack or
   // finally by _threadmain to exit.
   _exit: function(reason) {
      throw reason;
   },

   // A link has exited.  Destroy our suspended stack and kill the
   // process.  Any future calls to _resume will see zero-length
   // stack and do nothing.
   _linkexit: function(reason) {
      while (this._stack.length) {
         this._stack.pop().close();
      }
      Er._removeproc(this._pid, reason);
   },

   // See Er.receive description for what this is supposed to do.
   // Hashtable match requires matching all subelements, unless a '_'
   // key is specified.  Arrays match successfully if at least one
   // subelement matchs.
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
         this._linkexit(msg.Reason);
      } else {
         this._queue.push(msg);
      }
   },

   _sleep: function(millis) {
      setTimeout((yield this._CONTINUATION), millis);
      yield this._SUSPEND;
   },

   // Special yield value which tells a Thread to suspend execution.
   _SUSPEND: { toString: function() { return "[object ErProc._SUSPEND]" } },

   // Special yield value which tells a ErProc to send a continuation
   // callback for resuming a thread.
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
      ContentType: "application/x-www-form-urlencoded",
   },
   Response: {
      Headers: [],       // List of header names to return
      ContentType: null, // Override server's Content-Type
   },
   Timeout: 0,
   UseCache: false,
   IfModified: true,     // Set If-Modified-Since header
   NotifyHeaders: false,
   NotifyPartial: false
};


Er.Ajax = {
   DefaultOptions: new Er.AjaxOptions(),

   _lastModified: {}, // { url: last-modified }

   // NOTE: Requires yield.  POST to a URL (pseudo-)synchronously.
   // Waits until receiving a final status message with the Success
   // field set.  If true, returns the response text, otherwise
   // throws the failed status message.
   post: function(url, data, options) {
      return Er.Ajax._send(url, data, options);
   },

   // NOTE: Requires yield.  Like Er.Ajax.post, but GET content, converting
   // urldata into url query parameters.
   get: function(url, urldata, options) {
      if (urldata) {
         if (typeof(urldata) == "object")
            urldata = Er.Ajax._param(urldata);
         url += (url.match(/\?/) ? "&" : "?") + urldata;
      }
      return Er.Ajax._send(url, null, options);
   },

   // NOTE: Requires yield.  Like Er.Ajax.post, but use eval to
   // convert the result text into an object.
   json: function(url, data, options) {
      // XXX: Handle JSONP style callbacks
      var txt = Er.Ajax._send(url, data, options);
      return eval("(" + txt + ")");
   },

   // Helper to start a request and wait for the final status
   // message, returning the response body or throwing the failure
   // message.
   _send: function(url, data, options) {
      Er.Ajax.start(url, data, options);

      // Don't need yield because we don't expect to be called again
      return Er.receive({ Url: url, Success: true, _:_ },
                        function(msg) { return msg.Text; },
                        { Url: url, Success: false, _:_ },
                        function(msg) { throw msg; });
   },

   _merge: function(dest, src) {
      if (!dest.prototype)
         dest.prototype = src.prototype;
      for (i in src) {
         if (!dest.hasOwnProperty(i))  {
            dest[i] = src[i];
         } else {
            Er.Ajax._merge(dest[i], src[i])
         }
      }
   },

   // Serialize an array of form elements or a set of key/values into
   // a query string.  Ripped from jQuery.
   _param: function(obj) {
      var s = [];
      var enc = encodeURIComponent;

      // If an array was passed in, assume that it is an array of
      // form elements
      if (obj.constructor == Array) {
         // Serialize the form elements
         obj.forEach(function(v){
            s.push(enc(v.name) + "=" + enc(v.value));
         });
      } else {
         // Otherwise, assume that it's an object of key/value pairs
         for (j in obj) {
            // If the value is an array then the key names need to be repeated
            if (obj[j] && obj[j].constructor == Array) {
               obj[j].forEach(function(v){
                  s.push(enc(j) + "=" + enc(v));
               });
            } else {
               // Serialize the key/values
               s.push(enc(j) + "=" + enc(obj[j]));
            }
         }
      }

      // Return the resulting serialization
      return s.join("&").replace(/%20/g, "+");
   },

   /* Create and send an XMLHttpRequest for url, sending data as the
    * request body.  If data is an object it will be converted to a
    * param string.  Er.Ajax.DefaultOptions are used if no options
    * are specified.  Returns the created XMLHttpRequest.  Status
    * messages are delivered to the current pid, and take the form:
    *    { Url:        URL,
    *      Success:    true/false if finished,
    *      Text:       URL body text
    *      XmlDoc:     XMLDocument if response is XML
    *      Status:     HTTP status code,
    *      StatusText: HTTP status text,
    *      Headers:    { Optional response headers name/val } }
    * The last message will have a Success boolean set.
    */
   start: function(url, data, options) {
      var xml = new XMLHttpRequest();

      if (options)
         Er.Ajax._merge(options, Er.Ajax.DefaultOptions);
      else
         options = Er.Ajax.DefaultOptions;

      // Open the socket (async)
      xml.open(options.Method || (data ? "POST" : "GET"), url, true, 
               options.Username, options.Password);

      var _pid = Er.pid();
      xml.onreadystatechange = function() {
         if (!xml || (xml.readyState == 2 && !options.NotifyHeaders) ||
             (xml.readyState == 3 && !options.NotifyPartial) ||
             xml.readyState != 4)
            return;

         var msg = { Url: url,
                     Status: xml.status,
                     StatusText: xml.statusText,
                     Text: xml.responseText };

         if (options.Response.Headers.length) {
            msg.Headers = {};
            for (idx in options.Response.Headers)
               msg.Headers[header] = xml.getResponseHeader(
                  options.Response.Headers[idx]);
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

            xml = null;
         }

         Er.send(_pid, msg);
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
      if (data) {
         xml.setRequestHeader("Content-Type", options.Request.ContentType);
         if (typeof(data) == "object")
            data = Er.Ajax._param(data); // Stringify
      }

      xml.send(data);
      return xml;
   }
};


Er.DOM = {
   listen: function(elem, evtype, capture, stop, onetime) {
      var _pid = Er.pid();
      var listener = {
         handleEvent: function(ev) {
            Er.send(_pid, { Element: elem,
                            Event: ev,
                            Type: evtype,
                            Capture: capture });
            if (stop) {
               ev.preventDefault();
               ev.stopPropagation();
            }
            if (onetime) {
               elem.removeEventListener(evtype, listener, capture);
            }
         }
      };
      elem.addEventListener(evtype, listener, capture);
      return listener;
   },

   receive: function(elem, evtype, capture, stop) {
      Er.DOM.listen(elem, evtype, capture, stop, true);
      return Er.receive({ Element: elem,
                          Event: _,
                          Type: evtype,
                          Capture: capture },
                        function (msg) { return msg.Event });
   }
};
